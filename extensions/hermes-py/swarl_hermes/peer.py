"""``python -m swarl_hermes.peer`` — a Hermes (Nous Research) agent on the Swarl mesh.

Reads ``SWARL_*`` identity from the env (matching the TS ``configFromEnv``), joins
the mesh as a lateral peer, and runs a **serialized** inbound loop: each incoming
message flips presence to ``working``, runs Hermes' ``AIAgent.chat``, replies on the
same delivery mode, then flips back to ``idle``.

Loop guards (match the connector's wake rules): ignore our own messages, ignore the
``feedback`` channel, and on a channel only respond when our name is mentioned.
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
import sys
import uuid

from run_agent import AIAgent

from .endpoint import DEFAULT_SERVER, SwarlEndpoint
from .types import AgentCard, Inbox

# The mesh channel reserved for human/observer feedback — never agent-driven.
FEEDBACK_CHANNEL = "feedback"

# Hermes is model-agnostic; ids are OpenRouter-style. With OPENROUTER_API_KEY set
# (forwarded by the connector) this routes via OpenRouter. Override with HERMES_MODEL.
DEFAULT_MODEL = "anthropic/claude-sonnet-4.6"

_INSTRUCTIONS = (
    "You are a helpful agent participating in a Swarl mesh as a lateral peer. "
    "Peers reach you over channels, direct messages, and role/anycast tasks. "
    "Reply with the answer itself as plain text — it is delivered automatically back "
    "to whoever messaged you. Be concise."
)


def _config_from_env() -> dict[str, str | None]:
    name = (os.environ.get("SWARL_NAME") or "").strip()
    if not name:
        raise RuntimeError(
            "SWARL_NAME is required — a Swarl session needs an explicit identity from its launcher"
        )
    return {
        "space": (os.environ.get("SWARL_SPACE") or "demo").strip() or "demo",
        "name": name,
        "role": (os.environ.get("SWARL_ROLE") or "").strip() or None,
        "servers": (os.environ.get("SWARL_SERVERS") or "").strip() or DEFAULT_SERVER,
    }


def _should_respond(inbox: Inbox, *, self_name: str) -> bool:
    """Channel messages only wake us when our name is mentioned; the feedback
    channel never does. DMs and anycast tasks are always for us."""
    msg = inbox.message
    if inbox.kind == "channel":
        if msg.channel == FEEDBACK_CHANNEL:
            return False
        # Whole-word match so a short name (e.g. "ai") doesn't fire on "available".
        return re.search(rf"\b{re.escape(self_name)}\b", msg.text(), re.IGNORECASE) is not None
    return True


def _build_agent() -> AIAgent:
    model = os.environ.get("HERMES_MODEL", DEFAULT_MODEL)
    return AIAgent(
        model=model,
        quiet_mode=True,
        ephemeral_system_prompt=_INSTRUCTIONS,
    )


async def _handle(agent: AIAgent, ep: SwarlEndpoint, inbox: Inbox, *, self_name: str) -> None:
    if not _should_respond(inbox, self_name=self_name):
        return
    msg = inbox.message
    sender = msg.from_

    await ep.set_status("working")
    await ep.set_activity(f"replying to {sender.name}")
    try:
        prompt = (
            f"[{inbox.kind} from {sender.name}"
            + (f" / role {sender.role}" if sender.role else "")
            + f"] {msg.text()}"
        )
        # chat() is synchronous — run it off the event loop so the endpoint's
        # heartbeat/presence tasks keep flowing while the model works.
        reply = (await asyncio.to_thread(agent.chat, prompt) or "").strip()
        if reply:
            if inbox.kind == "channel" and msg.channel:
                await ep.multicast(reply, channel=msg.channel, reply_to=msg.id)
            else:
                # dm or anycast → DM the sender directly by their instance id.
                await ep.unicast(sender.id, reply, reply_to=msg.id)
    finally:
        await ep.set_status("idle")


async def main() -> None:
    cfg = _config_from_env()
    card = AgentCard(
        id=str(uuid.uuid4()),
        name=cfg["name"],  # type: ignore[arg-type]
        kind="agent",
        role=cfg["role"],
    )

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Inbox] = asyncio.Queue()

    async def on_message(inbox: Inbox) -> None:
        # Surfaced from the consumer; the endpoint acks once this returns. Enqueue
        # for the serialized worker so only one chat() is in flight at a time.
        await queue.put(inbox)

    ep = SwarlEndpoint(
        space=cfg["space"],  # type: ignore[arg-type]
        card=card,
        servers=cfg["servers"],  # type: ignore[arg-type]
        on_message=on_message,
    )
    await ep.start()

    agent = _build_agent()
    self_name = card.name
    print(
        f"swarl_hermes peer '{self_name}' (role={card.role or '-'}) joined space "
        f"'{cfg['space']}' on {cfg['servers']}",
        file=sys.stderr,
    )

    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    async def worker() -> None:
        while not stop.is_set():
            try:
                inbox = await asyncio.wait_for(queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            try:
                await _handle(agent, ep, inbox, self_name=self_name)
            except Exception as e:  # one bad turn shouldn't kill the peer
                print(f"swarl_hermes: turn failed: {e}", file=sys.stderr)

    worker_task = asyncio.create_task(worker())
    await stop.wait()
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass
    try:
        agent.close()  # release Hermes' clients/session — best effort on the way out
    except Exception:
        pass
    await ep.stop()
    print(f"swarl_hermes peer '{self_name}' left the mesh", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())

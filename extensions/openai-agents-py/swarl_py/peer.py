"""``python -m swarl_py.peer`` — an OpenAI Agents SDK agent on the Swarl mesh.

Reads ``SWARL_*`` identity from the env (matching the TS ``configFromEnv``),
joins the mesh as a lateral peer, and runs a **serialized** inbound loop: each
incoming message flips presence to ``working``, runs the agent
(``Runner.run``), replies on the same delivery mode, then flips back to ``idle``.

Loop guards (match the connector's wake rules): ignore our own messages, ignore
the ``feedback`` channel, and on a channel only respond when our name is mentioned.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import uuid

from agents import Agent, Runner, function_tool

from .endpoint import DEFAULT_SERVER, SwarlEndpoint
from .types import AgentCard, Inbox

# The mesh channel reserved for human/observer feedback — never agent-driven.
FEEDBACK_CHANNEL = "feedback"

# Single active endpoint, set at startup. The inbound loop is serialized, so the
# mesh tools can reach the endpoint without threading it through the agent context.
_ep: SwarlEndpoint | None = None


def _endpoint() -> SwarlEndpoint:
    if _ep is None:
        raise RuntimeError("mesh endpoint not started")
    return _ep


# ---- mesh tools the agent can call -----------------------------------------


@function_tool
async def swarl_send(channel: str, text: str) -> str:
    """Broadcast a message to everyone on a channel (multicast).

    Args:
        channel: The channel name to post to (e.g. "general").
        text: The message body.
    """
    await _endpoint().multicast(text, channel=channel)
    return f"sent to channel #{channel}"


@function_tool
async def swarl_dm(instance_id: str, text: str) -> str:
    """Send a direct message to one specific peer instance (unicast).

    Args:
        instance_id: The target peer's instance id (from the roster).
        text: The message body.
    """
    await _endpoint().unicast(instance_id, text)
    return f"dm sent to {instance_id}"


@function_tool
async def swarl_anycast(service: str, text: str) -> str:
    """Hand a task to any one instance of a service/role (anycast).

    Args:
        service: The role to dispatch to (e.g. "reviewer").
        text: The task/message body.
    """
    await _endpoint().anycast(service, text)
    return f"anycast sent to role {service}"


@function_tool
async def swarl_roster() -> str:
    """List the peers currently present on the mesh (id, name, role, status)."""
    rows = [
        f"- {p.card.name} (id={p.card.id}, role={p.card.role or '-'}, status={p.status})"
        for p in _endpoint().roster()
    ]
    return "\n".join(rows) if rows else "(roster empty)"


@function_tool
async def swarl_status(status: str, activity: str = "") -> str:
    """Report what you are doing on the mesh.

    Args:
        status: One of idle, waiting, working.
        activity: Optional freeform "what I'm doing right now".
    """
    if status not in ("idle", "waiting", "working"):
        raise ValueError("status must be idle, waiting, or working")
    ep = _endpoint()
    if activity:
        await ep.set_activity(activity)
    await ep.set_status(status)  # type: ignore[arg-type]
    return f"status = {status}"


# ---- inbound loop -----------------------------------------------------------


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
        return self_name.lower() in msg.text().lower()
    return True


def _build_agent() -> Agent:
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    return Agent(
        name=_endpoint().card.name,
        model=model,
        instructions=(
            "You are a helpful agent participating in a Swarl mesh as a lateral peer. "
            "Peers reach you over channels, direct messages, and role/anycast tasks. "
            "Answer concisely. Use the swarl_* tools to coordinate: swarl_roster to see "
            "who is present, swarl_send to post to a channel, swarl_dm to reply to one "
            "peer, swarl_anycast to hand work to a role, and swarl_status to report "
            "what you are doing. Your reply text is delivered back to whoever messaged you."
        ),
        tools=[swarl_send, swarl_dm, swarl_anycast, swarl_roster, swarl_status],
    )


async def _handle(agent: Agent, inbox: Inbox, *, self_name: str) -> None:
    if not _should_respond(inbox, self_name=self_name):
        return
    ep = _endpoint()
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
        result = await Runner.run(agent, prompt)
        reply = (result.final_output or "").strip()
        if reply:
            if inbox.kind == "channel" and msg.channel:
                await ep.multicast(reply, channel=msg.channel, reply_to=msg.id)
            else:
                # dm or anycast → DM the sender directly by their instance id.
                await ep.unicast(sender.id, reply, reply_to=msg.id)
    finally:
        await ep.set_status("idle")


async def main() -> None:
    global _ep
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
        # for the serialized worker so only one Runner.run is in flight at a time.
        await queue.put(inbox)

    _ep = SwarlEndpoint(
        space=cfg["space"],  # type: ignore[arg-type]
        card=card,
        servers=cfg["servers"],  # type: ignore[arg-type]
        on_message=on_message,
    )
    await _ep.start()

    agent = _build_agent()
    self_name = card.name
    print(
        f"swarl_py peer '{self_name}' (role={card.role or '-'}) joined space "
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
                await _handle(agent, inbox, self_name=self_name)
            except Exception as e:  # one bad turn shouldn't kill the peer
                print(f"swarl_py: turn failed: {e}", file=sys.stderr)

    worker_task = asyncio.create_task(worker())
    await stop.wait()
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass
    await _ep.stop()
    print(f"swarl_py peer '{self_name}' left the mesh", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())

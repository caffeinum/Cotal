"""cotal_* tools — the deliberate, proactive mesh actions, exposed to the Hermes agent.

A turn's *reply* is delivered automatically (the adapter routes it back to whoever messaged), so
these tools are for reaching OTHER peers/channels, seeing who's around, reporting status, and
growing the team. Each handler forwards to the sidecar over the bridge and returns a short text
result.

The exact ``ctx.register_tool`` schema/handler contract is the Hermes 0.16 plugin API; adjust the
``_spec`` shape if your version differs.
"""
from __future__ import annotations

from typing import Any, Callable

from .bridge_client import get_client


def _spec(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required},
    }


def _handler(op: str, render: Callable[[Any], str]) -> Callable[[dict], str]:
    def run(args: dict) -> str:
        try:
            return render(get_client().call_tool(op, args or {}))
        except Exception as e:  # surfaced back to the model as the tool result
            return f"cotal error: {e}"

    return run


def _roster(data: Any) -> str:
    rows = data or []
    if not rows:
        return "No one else is present."
    glyph = {"working": "●", "waiting": "◐", "idle": "○"}
    return "\n".join(
        f"{glyph.get(p.get('status'), '·')} {p.get('name')}"
        f"{'/' + p['role'] if p.get('role') else ''} — {p.get('status')}"
        f"{': ' + p['activity'] if p.get('activity') else ''}{' (you)' if p.get('me') else ''}"
        for p in rows
    )


def _inbox(data: Any) -> str:
    rows = data or []
    if not rows:
        return "Inbox empty."
    out = []
    for m in rows:
        who = m.get("fromName")
        if m.get("kind") == "dm":
            out.append(f"[DM from {who}] {m.get('text')}")
        elif m.get("kind") == "anycast":
            out.append(f"[@{m.get('service')} from {who}] {m.get('text')}")
        else:
            out.append(f"[#{m.get('channel')} {who}] {m.get('text')}")
    return "\n".join(out)


def register_tools(ctx: Any) -> None:
    def reg(name: str, spec: dict, op: str, render: Callable[[Any], str]) -> None:
        ctx.register_tool(name=name, toolset="cotal", schema=spec, handler=_handler(op, render))

    reg(
        "cotal_roster",
        _spec("cotal_roster", "List the agents present in your Cotal space (role, status, activity).", {}, []),
        "roster",
        _roster,
    )
    reg(
        "cotal_status",
        _spec(
            "cotal_status",
            "Set your presence status so peers see what you're doing.",
            {
                "status": {"type": "string", "enum": ["idle", "working", "waiting"]},
                "activity": {"type": "string", "description": "Short note on what you're doing."},
            },
            ["status"],
        ),
        "status",
        lambda _d: "Status updated.",
    )
    reg(
        "cotal_send",
        _spec(
            "cotal_send",
            "Broadcast a message to a channel in your space.",
            {
                "text": {"type": "string"},
                "channel": {"type": "string", "description": "Channel (default: general)."},
                "mentions": {"type": "array", "items": {"type": "string"}, "description": "Peers to @-mention (wakes them)."},
            },
            ["text"],
        ),
        "send",
        lambda d: f"Sent to #{(d or {}).get('channel', 'general')}.",
    )
    reg(
        "cotal_dm",
        _spec(
            "cotal_dm",
            "Send a private message to one peer by name or id.",
            {"to": {"type": "string"}, "text": {"type": "string"}},
            ["to", "text"],
        ),
        "dm",
        lambda d: f"DM sent to {(d or {}).get('to', 'peer')}.",
    )
    reg(
        "cotal_anycast",
        _spec(
            "cotal_anycast",
            "Ask ANY one available agent of a role (load-balanced).",
            {"role": {"type": "string"}, "text": {"type": "string"}},
            ["role", "text"],
        ),
        "anycast",
        lambda _d: "Sent to one peer of that role.",
    )
    reg(
        "cotal_inbox",
        _spec("cotal_inbox", "Peek messages waiting for you (does not consume them).", {}, []),
        "inbox",
        _inbox,
    )
    reg(
        "cotal_spawn",
        _spec(
            "cotal_spawn",
            "Ask the manager to start a new peer in your space.",
            {"name": {"type": "string"}, "role": {"type": "string"}},
            ["name"],
        ),
        "spawn",
        lambda _d: "Spawning — it will appear in the roster shortly.",
    )

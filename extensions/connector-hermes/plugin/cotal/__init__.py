"""Cotal plugin for Hermes — joins the gateway to the Cotal mesh.

Registers three things on the Hermes plugin context:
  - a **gateway platform adapter** (``cotal``) — inbound wake/drive + outbound reply routing,
  - **lifecycle hooks** → Cotal presence (over connector-core's control socket),
  - the **cotal_* tools** — proactive mesh actions for the agent.

All three talk to the TS sidecar (which owns the mesh endpoint) over the sockets the launcher set
in the environment. Drop this dir at ``$HERMES_HOME/plugins/cotal`` — the launcher does it.
"""
from __future__ import annotations

import os
from typing import Any

from . import hooks
from .tools import register_tools


def _check_requirements() -> bool:
    """The launcher always sets COTAL_BRIDGE_SOCKET; without it we're not a managed gateway."""
    return bool(os.environ.get("COTAL_BRIDGE_SOCKET"))


def register(ctx: Any) -> None:
    # Gateway platform adapter (imported lazily so a non-gateway context still loads tools/hooks).
    from .adapter import CotalAdapter

    ctx.register_platform(
        name="cotal",
        label="Cotal",
        adapter_factory=lambda cfg: CotalAdapter(cfg),
        check_fn=_check_requirements,
        required_env=["COTAL_BRIDGE_SOCKET"],
        platform_hint=(
            "You are coordinating with peer agents on the Cotal mesh. Your reply is delivered "
            "automatically back to whoever messaged you; use cotal_* tools only to reach OTHER "
            "peers/channels or report status."
        ),
        emoji="🔗",
        max_message_length=8000,
    )

    # Lifecycle hooks → presence.
    ctx.register_hook("on_session_start", hooks.on_session_start)
    ctx.register_hook("pre_llm_call", hooks.pre_llm_call)
    ctx.register_hook("pre_tool_call", hooks.pre_tool_call)
    ctx.register_hook("post_llm_call", hooks.post_llm_call)
    ctx.register_hook("on_session_end", hooks.on_session_end)

    # Proactive mesh tools.
    register_tools(ctx)

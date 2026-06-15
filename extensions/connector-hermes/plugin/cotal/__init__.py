"""Cotal plugin for Hermes — joins the gateway to the Cotal mesh.

Registers three things on the Hermes plugin context:
  - a **gateway platform adapter** (``cotal``) — inbound wake/drive + outbound reply routing,
  - **lifecycle hooks** → Cotal presence (over connector-core's control socket),
  - the **cotal_* tools** — proactive mesh actions for the agent (full shared parity).

All three talk to the TS sidecar (which owns the mesh endpoint) over the sockets the launcher set
in the environment. Two run modes:
  - **Managed** — the Cotal launcher spawns this gateway with COTAL_BRIDGE_SOCKET (and the control
    socket + tools file) already set; we just register against them.
  - **Standalone** — a user's own ``hermes`` with the plugin installed: COTAL_SPACE / COTAL_NAME /
    COTAL_SERVERS are set but no bridge socket, so we spawn the bundled sidecar ourselves, derive
    the socket/file paths, and register against those.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from . import hooks
from .tools import register_tools


def _is_managed() -> bool:
    """Managed launches preset the bridge socket; its presence means the sidecar already exists."""
    return bool(os.environ.get("COTAL_BRIDGE_SOCKET"))


def _have_identity() -> bool:
    return bool(os.environ.get("COTAL_SPACE") and os.environ.get("COTAL_NAME"))


def _check_requirements() -> bool:
    """Enable the cotal platform when we can reach (or bootstrap) a sidecar: a preset bridge socket
    (managed) or enough identity to spawn one (standalone)."""
    return _is_managed() or _have_identity()


def _resolve_sidecar_js() -> Path:
    """Locate the bundled standalone sidecar (esbuild → dist/standalone.cjs). Honors an explicit
    COTAL_SIDECAR_JS override; otherwise resolves it relative to the installed package root. Throws
    if absent — no silent fallback. (Packaging across npm-install vs `hermes plugins install`
    layouts is finalized at distribution time; see docs/hermes-integration.md.)"""
    override = os.environ.get("COTAL_SIDECAR_JS")
    if override:
        p = Path(override)
        if not p.is_file():
            raise RuntimeError(f"COTAL_SIDECAR_JS={override} does not exist")
        return p
    # plugin/cotal/__init__.py → package root is two parents up; the bundle sits in dist/.
    candidate = Path(__file__).resolve().parents[2] / "dist" / "standalone.cjs"
    if not candidate.is_file():
        raise RuntimeError(
            f"bundled sidecar not found at {candidate} — build the connector (pnpm build) or set "
            "COTAL_SIDECAR_JS to dist/standalone.cjs"
        )
    return candidate


def _bootstrap_standalone_sidecar() -> None:
    """Standalone mode: spawn the bundled Node sidecar and wait until it has published the bridge
    socket + tools file. Sets the three path env vars first so the sidecar and the rest of this
    registration agree on them."""
    run_dir = Path(tempfile.mkdtemp(prefix="cotal-hermes-"))
    space = os.environ["COTAL_SPACE"]
    name = os.environ["COTAL_NAME"]
    os.environ.setdefault("COTAL_BRIDGE_SOCKET", str(run_dir / "bridge.sock"))
    os.environ.setdefault("COTAL_CONTROL_SOCKET", str(run_dir / "control.sock"))
    os.environ.setdefault("COTAL_TOOLS_FILE", str(run_dir / "cotal-tools.json"))

    sidecar = _resolve_sidecar_js()
    subprocess.Popen(  # noqa: S603 — trusted bundled asset
        ["node", str(sidecar)],
        env=os.environ.copy(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Wait for the sidecar to be ready (tools file written + bridge socket bound). Fail loudly.
    tools_file = Path(os.environ["COTAL_TOOLS_FILE"])
    bridge_sock = Path(os.environ["COTAL_BRIDGE_SOCKET"])
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if tools_file.is_file() and bridge_sock.exists():
            return
        time.sleep(0.1)
    raise RuntimeError(
        f"cotal sidecar did not come up within 20s for {name}@{space} "
        f"(tools={tools_file.is_file()}, bridge={bridge_sock.exists()})"
    )


def register(ctx: Any) -> None:
    if not _is_managed():
        if not _have_identity():
            return  # not a cotal gateway — nothing to wire up
        _bootstrap_standalone_sidecar()

    # Gateway platform adapter (imported lazily so a non-gateway context still loads tools/hooks).
    from .adapter import CotalAdapter

    ctx.register_platform(
        name="cotal",
        label="Cotal",
        adapter_factory=lambda cfg: CotalAdapter(cfg),
        check_fn=_check_requirements,
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

    # Proactive mesh tools (declared from the descriptors the sidecar wrote to COTAL_TOOLS_FILE).
    register_tools(ctx)

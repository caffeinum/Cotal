"""Subject naming + stream/bucket names — a port of ``packages/core/src/subjects.ts``.

These strings ARE the routing half of the wire contract. They must match the TS
builders byte-for-byte so a Python peer and a TS peer route to the same place.
"""

import re

_ILLEGAL = re.compile(r"[^A-Za-z0-9_-]")

ROOT = "swarl"


def token(s: str) -> str:
    """Make a string safe as a single NATS subject token (mirrors `token` in TS)."""
    t = _ILLEGAL.sub("_", s.strip())
    return t if len(t) > 0 else "_"


def space_prefix(space: str) -> str:
    return f"{ROOT}.{token(space)}"


def chat_subject(space: str, channel: str) -> str:
    return f"{space_prefix(space)}.chat.{token(channel)}"


def unicast_subject(space: str, instance: str) -> str:
    """Unicast: a specific instance's inbox."""
    return f"{space_prefix(space)}.inst.{token(instance)}"


def anycast_subject(space: str, service: str) -> str:
    """Anycast: a service (role); subscribers join a queue group."""
    return f"{space_prefix(space)}.svc.{token(service)}"


def control_service_subject(space: str, service: str) -> str:
    return f"{space_prefix(space)}.ctl.{token(service)}"


def space_wildcard(space: str) -> str:
    return f"{space_prefix(space)}.>"


def presence_bucket(space: str) -> str:
    """Name of the KV bucket holding presence for a space."""
    return f"swarl_presence_{token(space)}"


# ---- JetStream streams (durable backing for the three delivery modes) ----


def chat_stream(space: str) -> str:
    return f"CHAT_{token(space)}"


def dm_stream(space: str) -> str:
    return f"DM_{token(space)}"


def task_stream(space: str) -> str:
    return f"TASK_{token(space)}"


def chat_durable(instance: str) -> str:
    return f"chat_{token(instance)}"


def dm_durable(instance: str) -> str:
    return f"dm_{token(instance)}"


def task_durable(service: str) -> str:
    return f"svc_{token(service)}"

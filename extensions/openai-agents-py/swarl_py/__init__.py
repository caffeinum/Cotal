"""Minimal Python Swarl client.

Interoperates on the wire with the TypeScript reference implementation
(``packages/core``). The subjects, stream/bucket names, message envelope and
presence record here are a direct port of that contract — a Python peer and a
TS peer share the same mesh.
"""

from .endpoint import SwarlEndpoint, DEFAULT_SERVER, is_reachable
from .types import AgentCard, Presence, SwarlMessage, EndpointRef, Part, Inbox

__all__ = [
    "SwarlEndpoint",
    "DEFAULT_SERVER",
    "is_reachable",
    "AgentCard",
    "Presence",
    "SwarlMessage",
    "EndpointRef",
    "Part",
    "Inbox",
]

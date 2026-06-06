"""Swarl wire types — a port of ``packages/core/src/types.ts``.

The JSON shapes that travel on the mesh. Field names match the TS interfaces
exactly; (de)serialization is plain ``json`` over these dataclasses. Optional
fields are omitted from the wire JSON when ``None`` (see :func:`message_to_wire`).
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

EndpointKind = Literal["agent", "endpoint"]
PresenceStatus = Literal["idle", "waiting", "working", "offline"]


@dataclass
class AgentCard:
    id: str
    name: str
    kind: EndpointKind
    role: Optional[str] = None
    capabilities: Optional[list[str]] = None
    meta: Optional[dict[str, Any]] = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "name": self.name, "kind": self.kind}
        if self.role is not None:
            out["role"] = self.role
        if self.capabilities is not None:
            out["capabilities"] = self.capabilities
        if self.meta is not None:
            out["meta"] = self.meta
        return out

    @staticmethod
    def from_wire(d: dict[str, Any]) -> "AgentCard":
        return AgentCard(
            id=d["id"],
            name=d["name"],
            kind=d.get("kind", "agent"),
            role=d.get("role"),
            capabilities=d.get("capabilities"),
            meta=d.get("meta"),
        )


@dataclass
class EndpointRef:
    id: str
    name: str
    role: Optional[str] = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "name": self.name}
        if self.role is not None:
            out["role"] = self.role
        return out

    @staticmethod
    def from_wire(d: dict[str, Any]) -> "EndpointRef":
        return EndpointRef(id=d["id"], name=d["name"], role=d.get("role"))


# Part is `{ "kind": "text", "text": str }` or `{ "kind": "data", "data": Any }`.
Part = dict[str, Any]


def text_part(text: str) -> Part:
    return {"kind": "text", "text": text}


@dataclass
class Presence:
    card: AgentCard
    status: PresenceStatus
    activity: Optional[str] = None
    ts: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"card": self.card.to_wire(), "status": self.status, "ts": self.ts}
        if self.activity is not None:
            out["activity"] = self.activity
        return out

    @staticmethod
    def from_wire(d: dict[str, Any]) -> "Presence":
        return Presence(
            card=AgentCard.from_wire(d["card"]),
            status=d.get("status", "idle"),
            activity=d.get("activity"),
            ts=d.get("ts", 0),
        )


@dataclass
class SwarlMessage:
    id: str
    ts: int
    space: str
    from_: EndpointRef
    parts: list[Part]
    # Exactly one of these is set:
    channel: Optional[str] = None
    to: Optional[str] = None
    to_service: Optional[str] = None
    reply_to: Optional[str] = None
    context_id: Optional[str] = None

    @staticmethod
    def new(
        space: str,
        from_: EndpointRef,
        parts: list[Part],
        *,
        channel: Optional[str] = None,
        to: Optional[str] = None,
        to_service: Optional[str] = None,
        reply_to: Optional[str] = None,
        context_id: Optional[str] = None,
    ) -> "SwarlMessage":
        return SwarlMessage(
            id=str(uuid.uuid4()),
            ts=int(time.time() * 1000),
            space=space,
            from_=from_,
            parts=parts,
            channel=channel,
            to=to,
            to_service=to_service,
            reply_to=reply_to,
            context_id=context_id,
        )

    def text(self) -> str:
        """Concatenate the text parts (data parts are ignored)."""
        return "".join(p.get("text", "") for p in self.parts if p.get("kind") == "text")

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "ts": self.ts,
            "space": self.space,
            "from": self.from_.to_wire(),
            "parts": self.parts,
        }
        if self.channel is not None:
            out["channel"] = self.channel
        if self.to is not None:
            out["to"] = self.to
        if self.to_service is not None:
            out["toService"] = self.to_service
        if self.reply_to is not None:
            out["replyTo"] = self.reply_to
        if self.context_id is not None:
            out["contextId"] = self.context_id
        return out

    def encode(self) -> bytes:
        return json.dumps(self.to_wire()).encode("utf-8")

    @staticmethod
    def from_wire(d: dict[str, Any]) -> "SwarlMessage":
        return SwarlMessage(
            id=d["id"],
            ts=d["ts"],
            space=d["space"],
            from_=EndpointRef.from_wire(d["from"]),
            parts=d.get("parts", []),
            channel=d.get("channel"),
            to=d.get("to"),
            to_service=d.get("toService"),
            reply_to=d.get("replyTo"),
            context_id=d.get("contextId"),
        )

    @staticmethod
    def decode(data: bytes) -> "SwarlMessage":
        return SwarlMessage.from_wire(json.loads(data.decode("utf-8")))


# Delivery mode of an inbound message, derived from which target field is set.
DeliveryKind = Literal["channel", "dm", "anycast"]


@dataclass
class Inbox:
    """One inbound message handed to a consumer, with its delivery classification."""

    message: SwarlMessage
    kind: DeliveryKind

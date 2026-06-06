"""Async Swarl endpoint — a wire-faithful port of ``packages/core/src/endpoint.ts``.

A Python peer that joins the same NATS/JetStream mesh as the TS reference
implementation. It ensures the same three streams + presence KV bucket, publishes
with ``Nats-Msg-Id`` dedup, binds the same-named durable consumers, and refreshes
presence on a heartbeat. No fallbacks: unsupported config raises.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Awaitable, Callable, Optional

import nats
from nats.aio.client import Client as NATS
from nats.js import JetStreamContext
from nats.js import api
from nats.js.errors import BadRequestError, NoKeysError
from nats.js.kv import KeyValue

from . import subjects as S
from .types import (
    AgentCard,
    EndpointRef,
    Inbox,
    Part,
    Presence,
    PresenceStatus,
    SwarlMessage,
    text_part,
)

DEFAULT_SERVER = "nats://127.0.0.1:4222"

# Async callback handed each inbound message; the endpoint awaits it, then acks.
InboxHandler = Callable[[Inbox], Awaitable[None]]


class SwarlEndpoint:
    """One participant on the mesh.

    Lifecycle: ``await ep.start()`` → publish via :meth:`multicast` /
    :meth:`unicast` / :meth:`anycast`, receive via the ``on_message`` handler,
    read peers via :meth:`roster` → ``await ep.stop()``.

    Defaults mirror the TS endpoint: heartbeat 2s, presence TTL 6s, ack_wait 60s,
    inactive_threshold 600s, default channel ``general``.
    """

    def __init__(
        self,
        *,
        space: str,
        card: AgentCard,
        servers: str = DEFAULT_SERVER,
        channels: Optional[list[str]] = None,
        on_message: Optional[InboxHandler] = None,
        heartbeat_ms: int = 2000,
        ttl_ms: int = 6000,
        register_presence: bool = True,
        watch_presence: bool = True,
        consume: bool = True,
        ack_wait_ms: int = 60_000,
        inactive_threshold_ms: int = 600_000,
    ) -> None:
        self.space = space
        if not card.id:
            card.id = str(uuid.uuid4())
        self.card = card
        self.servers = servers
        self.channels = channels if channels else ["general"]
        self._on_message = on_message
        self.heartbeat_ms = heartbeat_ms
        self.ttl_ms = ttl_ms
        self._do_register = register_presence
        self._do_watch = watch_presence
        self._do_consume = consume
        self.ack_wait_ms = ack_wait_ms
        self.inactive_threshold_ms = inactive_threshold_ms

        self._nc: Optional[NATS] = None
        self._js: Optional[JetStreamContext] = None
        self._kv: Optional[KeyValue] = None
        self._status: PresenceStatus = "idle"
        self._activity: Optional[str] = None
        self._roster: dict[str, Presence] = {}
        self._tasks: list[asyncio.Task] = []
        self._subs: list[JetStreamContext.PullSubscription] = []
        self._stopped = False

    # ---- identity -----------------------------------------------------------

    def ref(self) -> EndpointRef:
        return EndpointRef(id=self.card.id, name=self.card.name, role=self.card.role)

    @property
    def id(self) -> str:
        return self.card.id

    # ---- lifecycle ----------------------------------------------------------

    async def start(self) -> None:
        self._nc = await nats.connect(self.servers, name=f"swarl:{self.card.name}")
        self._js = self._nc.jetstream()

        if self._do_watch or self._do_register:
            self._kv = await self._ensure_kv()

        if self._do_watch:
            self._tasks.append(asyncio.create_task(self._watch_presence()))

        if self._do_register:
            await self._publish_presence()
            self._tasks.append(asyncio.create_task(self._heartbeat_loop()))

        if self._do_consume:
            await self._ensure_streams()
            await self._start_consumers()

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        # Best-effort graceful leave: flip presence to offline.
        if self._do_register and self._kv is not None:
            try:
                self._status = "offline"
                await self._publish_presence()
            except Exception:
                pass
        if self._nc is not None:
            try:
                await self._nc.drain()
            except Exception:
                try:
                    await self._nc.close()
                except Exception:
                    pass

    # ---- messaging ----------------------------------------------------------

    async def multicast(
        self,
        text: str,
        *,
        channel: Optional[str] = None,
        reply_to: Optional[str] = None,
        context_id: Optional[str] = None,
    ) -> SwarlMessage:
        ch = channel or (self.channels[0] if self.channels else "general")
        msg = SwarlMessage.new(
            self.space, self.ref(), [text_part(text)],
            channel=ch, reply_to=reply_to, context_id=context_id,
        )
        await self._publish(S.chat_subject(self.space, ch), msg)
        return msg

    async def unicast(
        self,
        instance_id: str,
        text: str,
        *,
        reply_to: Optional[str] = None,
        context_id: Optional[str] = None,
    ) -> SwarlMessage:
        msg = SwarlMessage.new(
            self.space, self.ref(), [text_part(text)],
            to=instance_id, reply_to=reply_to, context_id=context_id,
        )
        await self._publish(S.unicast_subject(self.space, instance_id), msg)
        return msg

    async def anycast(
        self,
        service: str,
        text: str,
        *,
        reply_to: Optional[str] = None,
        context_id: Optional[str] = None,
    ) -> SwarlMessage:
        msg = SwarlMessage.new(
            self.space, self.ref(), [text_part(text)],
            to_service=service, reply_to=reply_to, context_id=context_id,
        )
        await self._publish(S.anycast_subject(self.space, service), msg)
        return msg

    async def _publish(self, subject: str, msg: SwarlMessage) -> None:
        if self._js is None:
            raise RuntimeError("endpoint not started")
        # Nats-Msg-Id = message id → server-side dedup across JetStream redelivery.
        await self._js.publish(subject, msg.encode(), headers={"Nats-Msg-Id": msg.id})

    # ---- presence -----------------------------------------------------------

    def roster(self) -> list[Presence]:
        return sorted(self._roster.values(), key=lambda p: p.card.name.lower())

    async def set_status(self, status: PresenceStatus) -> None:
        self._status = status
        await self._publish_presence()

    async def set_activity(self, activity: str) -> None:
        self._activity = activity
        await self._publish_presence()

    async def _ensure_kv(self) -> KeyValue:
        assert self._js is not None
        bucket = S.presence_bucket(self.space)
        cfg = api.KeyValueConfig(bucket=bucket, ttl=self.ttl_ms / 1000.0)
        try:
            return await self._js.create_key_value(config=cfg)
        except BadRequestError:
            # Already exists (possibly created by a TS peer) — bind to it.
            return await self._js.key_value(bucket)

    async def _publish_presence(self) -> None:
        if self._kv is None:
            return
        p = Presence(card=self.card, status=self._status, activity=self._activity,
                     ts=int(time.time() * 1000))
        await self._kv.put(self.card.id, json.dumps(p.to_wire()).encode("utf-8"))

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(self.heartbeat_ms / 1000.0)
            try:
                await self._publish_presence()
            except Exception:
                pass

    async def _watch_presence(self) -> None:
        assert self._kv is not None
        watcher = await self._kv.watchall()
        async for entry in watcher:
            if entry is None:
                continue
            op = entry.operation
            if op in ("DEL", "PURGE"):
                self._roster.pop(entry.key, None)
                continue
            if not entry.value:
                continue
            try:
                p = Presence.from_wire(json.loads(entry.value.decode("utf-8")))
            except Exception:
                continue
            self._roster[entry.key] = p

    # ---- streams + consumers ------------------------------------------------

    async def _ensure_streams(self) -> None:
        assert self._js is not None
        p = S.space_prefix(self.space)
        # chat.> — multicast backlog + history (capped per-subject, discard old).
        await self._add_stream(api.StreamConfig(
            name=S.chat_stream(self.space),
            subjects=[f"{p}.chat.>"],
            retention=api.RetentionPolicy.LIMITS,
            storage=api.StorageType.FILE,
            max_msgs_per_subject=1000,
            discard=api.DiscardPolicy.OLD,
        ))
        # inst.> — per-instance DM inboxes.
        await self._add_stream(api.StreamConfig(
            name=S.dm_stream(self.space),
            subjects=[f"{p}.inst.>"],
            retention=api.RetentionPolicy.LIMITS,
            storage=api.StorageType.FILE,
        ))
        # svc.> — anycast work queue.
        await self._add_stream(api.StreamConfig(
            name=S.task_stream(self.space),
            subjects=[f"{p}.svc.>"],
            retention=api.RetentionPolicy.WORK_QUEUE,
            storage=api.StorageType.FILE,
        ))

    async def _add_stream(self, cfg: api.StreamConfig) -> None:
        assert self._js is not None
        try:
            await self._js.add_stream(config=cfg)
        except BadRequestError:
            # Already exists with a compatible config (e.g. created by a TS peer).
            pass

    async def _start_consumers(self) -> None:
        assert self._js is not None
        ack_wait = self.ack_wait_ms / 1000.0
        inactive = self.inactive_threshold_ms / 1000.0
        cid = self.card.id

        # Unicast: this instance's private DM inbox.
        await self._add_consumer(S.dm_stream(self.space), api.ConsumerConfig(
            durable_name=S.dm_durable(cid),
            filter_subject=S.unicast_subject(self.space, cid),
            ack_policy=api.AckPolicy.EXPLICIT,
            ack_wait=ack_wait,
            deliver_policy=api.DeliverPolicy.ALL,
            inactive_threshold=inactive,
        ))
        await self._pump("dm", S.dm_stream(self.space), S.dm_durable(cid))

        # Multicast: our channels, replaying the retained window at our own pace.
        if self.channels:
            await self._add_consumer(S.chat_stream(self.space), api.ConsumerConfig(
                durable_name=S.chat_durable(cid),
                filter_subjects=[S.chat_subject(self.space, ch) for ch in self.channels],
                ack_policy=api.AckPolicy.EXPLICIT,
                ack_wait=ack_wait,
                deliver_policy=api.DeliverPolicy.ALL,
                inactive_threshold=inactive,
            ))
            await self._pump("channel", S.chat_stream(self.space), S.chat_durable(cid))

        # Anycast: shared work-queue consumer for our role — one instance per task.
        if self.card.role:
            await self._add_consumer(S.task_stream(self.space), api.ConsumerConfig(
                durable_name=S.task_durable(self.card.role),
                filter_subject=S.anycast_subject(self.space, self.card.role),
                ack_policy=api.AckPolicy.EXPLICIT,
                ack_wait=ack_wait,
            ))
            await self._pump("anycast", S.task_stream(self.space), S.task_durable(self.card.role))

    async def _add_consumer(self, stream: str, cfg: api.ConsumerConfig) -> None:
        assert self._js is not None
        try:
            await self._js.add_consumer(stream, config=cfg)
        except BadRequestError:
            # Durable already exists with a compatible config.
            pass

    async def _pump(self, kind: str, stream: str, durable: str) -> None:
        assert self._js is not None
        sub = await self._js.pull_subscribe_bind(durable=durable, stream=stream)
        self._subs.append(sub)
        self._tasks.append(asyncio.create_task(self._pump_loop(kind, sub)))

    async def _pump_loop(self, kind: str, sub: JetStreamContext.PullSubscription) -> None:
        while not self._stopped:
            try:
                msgs = await sub.fetch(batch=1, timeout=5)
            except (nats.errors.TimeoutError, asyncio.TimeoutError):
                continue
            except asyncio.CancelledError:
                raise
            except Exception:
                # Consumer gone / connection draining — stop quietly.
                if self._stopped:
                    return
                await asyncio.sleep(0.2)
                continue
            for m in msgs:
                try:
                    msg = SwarlMessage.decode(m.data)
                except Exception:
                    await m.term()  # undecodable — never redeliver
                    continue
                if msg.from_.id == self.card.id:
                    await m.ack()  # our own echo — advance past it
                    continue
                if self._on_message is None:
                    await m.ack()
                    continue
                try:
                    await self._on_message(Inbox(message=msg, kind=kind))  # type: ignore[arg-type]
                    await m.ack()  # ack ONLY once surfaced/handled (matches TS)
                except Exception:
                    await m.nak()


async def is_reachable(servers: str = DEFAULT_SERVER, timeout_ms: int = 1000) -> bool:
    """Quick check whether a NATS server is accepting connections."""
    try:
        nc = await nats.connect(
            servers,
            connect_timeout=timeout_ms / 1000.0,
            allow_reconnect=False,
            max_reconnect_attempts=0,
        )
        await nc.close()
        return True
    except Exception:
        return False

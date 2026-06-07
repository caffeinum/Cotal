# Licensing

Swarl is **Apache-2.0** (see [LICENSE](LICENSE)) — all of it: the wire protocol,
`@swarl/core`, every extension, and the CLI.

**Why permissive.** A protocol is only worth something if people adopt it.
Apache-2.0 lets anyone embed Swarl in their own agents (proprietary included) or
reimplement it in another language, and it carries a patent grant. It's what the
protocols Swarl sits alongside use too — MCP, A2A, gRPC, and NATS itself. The wire
contract in `docs/` is part of the standard; independent implementations are welcome.

**Trademark.** Apache grants no trademark rights. The "Swarl" name and logo are
reserved by the project — build on the code freely, just don't imply your fork is
official Swarl.

**Commercial / hosted (future).** A managed server and hosted control plane
("Swarl Cloud") are how this gets funded later. When they ship, the *server* may be
offered under AGPL-3.0-or-later plus a commercial license, while the SDKs and the
wire spec stay Apache-2.0. None of that applies to anything in this repo today.

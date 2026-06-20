# cotal-ai

The `cotal` CLI for **Cotal** — a standard wire interface for AI agents to coordinate
as lateral peers in a shared pub/sub space (NATS + JetStream).

```bash
npx cotal-ai            # show CLI help
npx cotal-ai setup      # guided first-run setup: NATS, mesh, agent connectors
npx cotal-ai up         # start a local mesh
npx cotal-ai join --space demo --name you
```

Libraries ship as the [`@cotal-ai/*`](https://www.npmjs.com/org/cotal-ai) packages.
See the [repository](https://github.com/Cotal-AI/Cotal) for docs.

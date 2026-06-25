---
"@cotal-ai/manager": patch
---

Fix: `cotal ps` / `start` / `stop` / `attach` now resolve their broker from the mesh registry — the
same way `send` / `channels` / `console` / `web` and the manifest verbs already do — instead of
silently defaulting to `nats://127.0.0.1:4222`. Managing a manifest mesh on a non-default port no
longer needs an explicit `--server`: `--space <name>` finds the recorded broker, and `--server`
stays an override only. Each command also mints its privileged "manager" cred from the **resolved**
mesh's own recorded root, so `--space <other>` loads that mesh's trust material instead of failing
against the current folder's. `--creds` remains a raw off-registry escape hatch; the `supervise`
daemon is unchanged.

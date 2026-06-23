---
"@cotal-ai/cli": patch
---

web graph: drop nodes as soon as they go offline. Offline presence records stay
in the roster indefinitely, so the previous prune (only when a node left the
roster) never fired for them and offline agents accumulated on the graph forever.

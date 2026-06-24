/**
 * Human-readable rendering of a prepared manifest — the `cotal topology view` output and the shared
 * pieces of `--dry-run`. The native verbs get humane labels here so the field names aren't the only
 * explanation (UX): `subscribe (auto-listens at boot)` etc. No mutation, no live state.
 */
import { c } from "../../ui.js";
import type { PreparedManifest } from "./preflight.js";
import type { AgentWarning } from "./prepare.js";

const LABEL = {
  subscribe: "subscribe (auto-listens at boot)",
  allowSubscribe: "allowSubscribe (may read/join)",
  allowPublish: "allowPublish (may post)",
};

const list = (xs: string[]): string => (xs.length ? xs.join(", ") : c.dim("(none)"));

/** The full `topology view`: header, channel access, agent access, persona-inherited scopes, warnings. */
export function renderTopology(p: PreparedManifest): string {
  const m = p.manifest;
  const out: string[] = [];

  const broker = m.broker?.servers ?? "fresh local broker";
  out.push(
    c.bold(`Mesh "${m.space}"`) +
      c.dim(`  (broker: ${broker} · runtime ${m.runtime ?? "pty"} · personaPermissions: ${m.personaPermissions})`),
  );

  // Channels — who subscribes / may read / may post (agent names).
  out.push("", c.bold(`Channels (${m.channels.length})`));
  for (const ch of m.channels) {
    out.push(`  ${c.cyan("#" + ch.name)}${ch.description ? c.dim("  " + ch.description) : ""}`);
    out.push(`      ${c.dim(LABEL.subscribe + ":")}      ${list(ch.subscribe)}`);
    out.push(`      ${c.dim(LABEL.allowSubscribe + ":")}    ${list(ch.allowSubscribe)}`);
    out.push(`      ${c.dim(LABEL.allowPublish + ":")}      ${list(ch.allowPublish)}`);
    if (ch.instructions) out.push(`      ${c.dim("instructions: " + ch.instructions)}`);
  }

  // Agents — effective merged access (manifest + any persona-inherited under `include`).
  out.push("", c.bold(`Agents (${p.agents.length})`));
  for (const a of p.agents) {
    const src = a.persona ? `persona ${a.persona}` : "inline";
    const meta = [a.agentType, a.model ? `model ${a.model}` : undefined, a.role ? `role ${a.role}` : undefined]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${c.bold(a.name)}  ${c.dim(meta + " · " + src)}`);
    out.push(`      ${c.dim(LABEL.subscribe + ":")}      ${list(a.policy.subscribe)}`);
    out.push(`      ${c.dim(LABEL.allowSubscribe + ":")}    ${list(a.policy.allowSubscribe)}`);
    out.push(`      ${c.dim(LABEL.allowPublish + ":")}      ${list(a.policy.allowPublish)}`);
    if (a.capabilities.length)
      out.push(`      ${c.dim("capabilities:")}      ${a.capabilities.join(", ")}${a.capabilitySource === "persona" ? c.dim(" (persona-inherited)") : ""}`);
  }

  const inherited = renderInherited(p);
  if (inherited) out.push("", inherited);

  if (p.warnings.length) out.push("", renderWarnings(p.warnings));
  return out.join("\n");
}

/** The loud "persona grants outside manifest channels" section — unmanaged credential scopes that
 *  an old persona ref drags in under `personaPermissions: include`. Returns "" when there are none. */
export function renderInherited(p: PreparedManifest): string {
  const rows: string[] = [];
  for (const a of p.agents) {
    const i = a.inherited;
    if (!i.subscribe.length && !i.allowSubscribe.length && !i.allowPublish.length) continue;
    const parts = [
      i.subscribe.length ? `subscribe ${i.subscribe.join(",")}` : "",
      i.allowSubscribe.length ? `read ${i.allowSubscribe.join(",")}` : "",
      i.allowPublish.length ? `post ${i.allowPublish.join(",")}` : "",
    ].filter(Boolean);
    rows.push(`  ${c.bold(a.name)} → ${parts.join(" · ")}  ${c.dim(`(persona ${a.persona} · unmanaged by manifest, no card)`)}`);
  }
  if (!rows.length) return "";
  return [c.yellow(c.bold("⚠ Persona-inherited access outside manifest channels")), ...rows].join("\n");
}

/** Render the non-fatal warnings (empty-ACL agents, loud when they carry capabilities). */
export function renderWarnings(warnings: AgentWarning[]): string {
  const rows = warnings.map((w) => `  ${w.loud ? c.yellow("‼") : c.dim("•")} ${c.bold(w.agent)}: ${w.message}`);
  return [c.yellow(c.bold(`⚠ Warnings (${warnings.length})`)), ...rows].join("\n");
}

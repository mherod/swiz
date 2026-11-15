import type { AgentDef } from "../../agents.ts"

/**
 * Agent permission-deny entries mirrored from `hooks/pretooluse-banned-commands.ts`.
 *
 * They are a backstop for when the hook layer is absent: the dispatch command
 * exits 0 without swiz on PATH, and a settings deny still holds. A settings deny
 * matches only a command prefix, cannot be carved out by an allow entry, and
 * shows the agent no guidance text. Only add a pattern that is all of:
 *   - about sandboxing or safety (not style or workflow preference);
 *   - narrow: the hook denies every command it can match, unconditionally;
 *   - obvious to route around: the agent can find the safer alternative unaided.
 * A broader pattern (e.g. `Bash(git stash:*)`, which also caught read-only
 * `git stash list`) blocks commands the hook deliberately permits.
 */
const SWIZ_PERMISSION_DENIES: Partial<Record<AgentDef["id"], readonly string[]>> = {
  claude: ["Bash(cd:*)"],
}

export function swizPermissionDenies(agent: AgentDef): readonly string[] {
  return SWIZ_PERMISSION_DENIES[agent.id] ?? []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Add swiz-managed deny entries, keeping user entries and their order. */
export function withSwizPermissionDenies(
  settings: Record<string, any>,
  agent: AgentDef
): Record<string, any> {
  const managed = swizPermissionDenies(agent)
  if (managed.length === 0) return settings
  const permissions = settings.permissions ?? {}
  if (!isRecord(permissions)) return settings
  const deny = permissions.deny ?? []
  if (!Array.isArray(deny)) return settings
  const missing = managed.filter((entry) => !deny.includes(entry))
  if (missing.length === 0) return settings
  return { ...settings, permissions: { ...permissions, deny: [...deny, ...missing] } }
}

/** Remove swiz-managed deny entries, dropping containers that become empty. */
export function withoutSwizPermissionDenies(
  settings: Record<string, any>,
  agent: AgentDef
): { settings: Record<string, any>; removed: number } {
  const managed = swizPermissionDenies(agent)
  const permissions = settings.permissions
  if (managed.length === 0 || !isRecord(permissions) || !Array.isArray(permissions.deny)) {
    return { settings, removed: 0 }
  }
  const deny = permissions.deny.filter((entry) => !managed.includes(entry))
  const removed = permissions.deny.length - deny.length
  if (removed === 0) return { settings, removed }

  const nextPermissions: Record<string, unknown> = { ...permissions, deny }
  if (deny.length === 0) delete nextPermissions.deny
  const next: Record<string, any> = { ...settings, permissions: nextPermissions }
  if (Object.keys(nextPermissions).length === 0) delete next.permissions
  return { settings: next, removed }
}

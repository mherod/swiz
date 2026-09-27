import { isAbsolute, relative, resolve, sep } from "node:path"
import { projectKeyFromCwd } from "./project-key.ts"
import { canonicalClaimPath, fileClaimProjectKey } from "./session-file-claims.ts"

/** Only these legacy keys have a filesystem-proven connection to the caller's root. */
export function sessionEditProjectKeys(cwd: string): string[] {
  return [...new Set([fileClaimProjectKey(cwd), projectKeyFromCwd(cwd)])]
}

/** A lossy project key alone cannot prove that a recorded file belongs to this root. */
export function resolveSessionEditPath(cwd: string, filePath: string): string | null {
  const root = canonicalClaimPath(cwd)
  const path = canonicalClaimPath(resolve(cwd, filePath))
  const rel = relative(root, path)
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? path : null
}

export const LEGACY_EDIT_HISTORY_WARNING =
  "Older edit history recorded through other directory aliases may be missing; inspect it through the original alias. Existing records are preserved."

import { join } from "node:path"

export const NODE_MODULES_DIR = "node_modules"

const NODE_MODULES_SEGMENT_RE = /(^|[\\/])node_modules([\\/]|$)/i

/**
 * True when `filePath` contains `node_modules` as a real path segment.
 */
export function isNodeModulesPath(filePath: string): boolean {
  return NODE_MODULES_SEGMENT_RE.test(filePath)
}

/**
 * Join a path under `<base>/node_modules/...`.
 */
export function joinNodeModulesPath(base: string, ...segments: string[]): string {
  return join(base, NODE_MODULES_DIR, ...segments)
}

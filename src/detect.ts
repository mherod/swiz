import { AGENTS, type AgentDef } from "./agents.ts"

// ─── Terminal & shell detection ──────────────────────────────────────────────
// Re-exported from hooks/utils/terminal-detection.ts so both src/ and hooks/
// consumers can access it via this central detect module.

export type {
  EnvironmentInfo,
  ShellInfo,
  ShellType,
  TerminalApp,
  TerminalInfo,
} from "../hooks/utils/terminal-detection.ts"
export {
  detectEnvironment,
  detectShell,
  detectTerminal,
} from "../hooks/utils/terminal-detection.ts"

/**
 * Detects the currently running agent by checking environment variables and parent process.
 *
 * Detection order:
 * 1. Environment variables (fast, reliable in hook contexts)
 * 2. Parent process command pattern (fallback when running in a shell)
 * 3. null if no agent detected
 */
export function detectCurrentAgent(): AgentDef | null {
  // First, check environment variables (fastest, most reliable in hooks)
  const byEnv = AGENTS.find((a) => a.envVars?.some((v) => process.env[v]))
  if (byEnv) return byEnv

  // Fallback: check parent process command pattern
  const parentCmd = getParentProcessCommand()
  return AGENTS.find((a) => a.processPattern?.test(parentCmd)) ?? null
}

/**
 * Get the command that started the current process.
 * Used to detect agent context when environment variables aren't set.
 */
function getParentProcessCommand(): string {
  try {
    const proc = Bun.spawnSync(["ps", "-p", String(process.ppid), "-o", "command="])
    return new TextDecoder().decode(proc.stdout).trim()
  } catch {
    return ""
  }
}

/**
 * Check if the current process is running inside a specific agent.
 */
export function isCurrentAgent(id: string): boolean {
  return detectCurrentAgent()?.id === id
}

/**
 * Check if running in any agent context (opposite of interactive shell).
 * This is a simpler check than detectCurrentAgent — just "are we in agent context?"
 *
 * Used by shell shims to decide whether to block or warn.
 */
export function isRunningInAgent(): boolean {
  // Non-interactive shell is almost certainly an agent
  if (!process.stdin.isTTY) return true

  // Check for known agent environment indicators
  if (process.env.CURSOR_TRACE_ID) return true
  if (process.env.CLAUDECODE) return true

  return false
}

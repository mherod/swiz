import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AGENTS, type AgentDef } from "./agents.ts"
import { resolveCwd } from "./cwd.ts"

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

export type CiProvider =
  | "github-actions"
  | "circleci"
  | "gitlab-ci"
  | "jenkins"
  | "azure-pipelines"
  | "buildkite"
  | "drone"
  | "travis"
  | "appveyor"
  | "bitrise"
  | "semaphore"
  | "codeship"
  | "woodpecker"

interface CiIndicator {
  provider: CiProvider
  files?: readonly string[]
  checkDir?: (dir: string) => Promise<boolean>
}

const CI_INDICATORS: readonly CiIndicator[] = [
  { provider: "github-actions", checkDir: hasGitHubWorkflowFile },
  { provider: "circleci", files: [".circleci/config.yml", ".circleci/config.yaml"] },
  { provider: "gitlab-ci", files: [".gitlab-ci.yml"] },
  { provider: "jenkins", files: ["Jenkinsfile", ".jenkins/Jenkinsfile"] },
  { provider: "azure-pipelines", files: ["azure-pipelines.yml", "azure-pipelines.yaml"] },
  { provider: "buildkite", files: [".buildkite/pipeline.yml", ".buildkite/pipeline.yaml"] },
  { provider: "drone", files: [".drone.yml", ".drone.yaml"] },
  { provider: "travis", files: [".travis.yml"] },
  { provider: "appveyor", files: ["appveyor.yml"] },
  { provider: "bitrise", files: ["bitrise.yml"] },
  { provider: "semaphore", files: [".semaphore/semaphore.yml"] },
  { provider: "codeship", files: ["codeship-services.yml", "codeship-steps.yml"] },
  { provider: "woodpecker", files: [".woodpecker.yml", ".woodpecker.yaml"] },
]

async function hasAnyFile(dir: string, relativeFiles: readonly string[]): Promise<boolean> {
  for (const file of relativeFiles) {
    if (await Bun.file(join(dir, file)).exists()) return true
  }
  return false
}

async function hasGitHubWorkflowFile(dir: string): Promise<boolean> {
  const workflowDir = join(dir, ".github", "workflows")
  try {
    const entries = await readdir(workflowDir, { withFileTypes: true })
    return entries.some((entry) => entry.isFile() && /\.(yml|yaml)$/i.test(entry.name))
  } catch {
    return false
  }
}

async function detectCiProvidersInDir(dir: string): Promise<Set<CiProvider>> {
  const providers = new Set<CiProvider>()
  for (const indicator of CI_INDICATORS) {
    if (indicator.files && (await hasAnyFile(dir, indicator.files))) {
      providers.add(indicator.provider)
      continue
    }
    if (indicator.checkDir && (await indicator.checkDir(dir))) {
      providers.add(indicator.provider)
    }
  }
  return providers
}

/**
 * Detect CI providers by scanning common CI config patterns from the current
 * directory up to the filesystem root.
 */
export async function detectCiProviders(startDir?: string): Promise<Set<CiProvider>> {
  let dir = resolveCwd(startDir)
  const providers = new Set<CiProvider>()

  while (true) {
    const localProviders = await detectCiProvidersInDir(dir)
    for (const provider of localProviders) providers.add(provider)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return providers
}

/** True when any known CI config is found in the current tree. */
export async function hasCiConfig(startDir?: string): Promise<boolean> {
  return (await detectCiProviders(startDir)).size > 0
}

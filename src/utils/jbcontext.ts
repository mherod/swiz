import { homedir } from "node:os"
import { join } from "node:path"
import { spawnWithTimeout } from "./process-utils.ts"

/**
 * Options for configuring jbcontext detection.
 */
export interface JbcontextDetectOptions {
  /** Explicit path to jbcontext binary or command name. */
  binaryPath?: string
  /** Override user home directory (defaults to process.env.HOME || homedir()). */
  homeDir?: string
  /** Project directory to inspect for indexing status. */
  projectPath?: string
  /** If true, checks the CLI version via `jbcontext --version` (default: true). */
  checkVersion?: boolean
  /** If true and projectPath is specified, checks project index status via `jbcontext status` (default: true). */
  checkProject?: boolean
  /**
   * If true, requires the specified project to be indexed for `configured` to be true.
   * Defaults to false (global configuration/auth is sufficient, project index is reported in .project).
   */
  requireProjectIndexed?: boolean
  /** Subprocess timeout in milliseconds (default: 3_000). */
  timeoutMs?: number
}

/**
 * Options for triggering jbcontext indexing.
 */
export interface JbcontextIndexOptions {
  /** Explicit path to jbcontext binary or command name. */
  binaryPath?: string
  /** Override user home directory. */
  homeDir?: string
  /** Project directory to index. */
  projectPath?: string
  /** Specific git revision to index (defaults to HEAD). */
  revision?: string
  /** Suppress progress output with --silent (default: true). */
  silent?: boolean
}

/**
 * Snapshot metadata within a project index.
 */
export interface JbcontextProjectSnapshot {
  revision: string
  branches?: string[]
  clusters?: number
  totalSizeKB?: number
  createdAt?: number
}

/**
 * Project index structure returned by jbcontext status.
 */
export interface JbcontextProjectIndex {
  name: string
  snapshots: JbcontextProjectSnapshot[]
}

/**
 * Indexing and repository status for a specific project.
 */
export interface JbcontextProjectStatus {
  repositoryId?: string
  repositoryUrl?: string
  indexed: boolean
  indices: JbcontextProjectIndex[]
  message?: string
}

/**
 * Result of jbcontext availability and configuration detection.
 */
export interface JbcontextDetection {
  /** True if jbcontext binary is found and runnable. */
  available: boolean
  /**
   * True if jbcontext is available and configured (has config file and valid credentials/pins or agent setups).
   * If requireProjectIndexed is true and projectPath is provided, requires the project to also be indexed.
   */
  configured: boolean
  /** Path to the resolved binary, or null if not found. */
  binaryPath: string | null
  /** CLI version output from `jbcontext --version` or activeVersion from config. */
  version: string | null
  /** Directory where jbcontext configuration is stored (~/.jbcontext). */
  configDir: string
  /** True if ~/.jbcontext/config.json exists. */
  hasConfigFile: boolean
  /** True if auth credentials, pins, or tokens are present in configDir. */
  authenticated: boolean
  /** Configured agent integrations from config.json (e.g. { "CLAUDE:USER": ... }). */
  agentSetups?: Record<string, unknown>
  /** Active version recorded in config.json. */
  activeVersion?: string
  /** AI access selections / license details from config.json. */
  aiAccessSelections?: Record<string, unknown>
  /** Status of project indexing when projectPath is provided and checked. */
  project?: JbcontextProjectStatus
  /** Error message encountered during detection, if any. */
  error?: string
}

const DEFAULT_TIMEOUT_MS = 3_000

const TOKEN_FILES = [
  "grazie-token-prod.json",
  "grazie-token-eap.json",
  "jcp-oauth-prod.json",
  "jcp-oauth-eap.json",
] as const

function resolveHomeDir(options?: JbcontextDetectOptions): string {
  if (options?.homeDir) return options.homeDir
  return process.env.HOME || homedir()
}

function resolveTimeoutMs(options?: JbcontextDetectOptions): number {
  if (options && typeof options.timeoutMs === "number") return options.timeoutMs
  return DEFAULT_TIMEOUT_MS
}

async function resolveExplicitBinary(path: string): Promise<string | null> {
  if (!path) return null
  if (await Bun.file(path).exists()) return path
  const onPath = Bun.which(path)
  return onPath && (await Bun.file(onPath).exists()) ? onPath : null
}

async function resolveHomeBinaries(home: string): Promise<string | null> {
  const wrapper = join(home, ".jbcontext", "bin", "jbcontext")
  if (await Bun.file(wrapper).exists()) return wrapper
  const binary = join(home, ".jbcontext", "bin", "jbcontext_binary")
  if (await Bun.file(binary).exists()) return binary
  return null
}

/**
 * Resolve the path to the jbcontext binary.
 */
export async function resolveJbcontextBinary(
  options?: Pick<JbcontextDetectOptions, "binaryPath" | "homeDir">
): Promise<string | null> {
  if (options && options.binaryPath !== undefined) {
    return resolveExplicitBinary(options.binaryPath)
  }

  if (options?.homeDir) {
    return resolveHomeBinaries(options.homeDir)
  }

  const onPath = Bun.which("jbcontext")
  if (onPath && (await Bun.file(onPath).exists())) {
    return onPath
  }

  const defaultHome = process.env.HOME || homedir()
  return resolveHomeBinaries(defaultHome)
}

function parseJbcontextVersion(output: string): string | null {
  const match = output.match(/jbcontext(?:\s+version)?\s+([0-9]+(?:\.[0-9]+)+(?:-[a-zA-Z0-9.]+)?)/i)
  if (match?.[1]) return match[1]
  const firstLine = output.trim().split("\n")[0]
  return firstLine?.trim() || null
}

async function queryCliVersion(
  binaryPath: string,
  timeoutMs: number
): Promise<{ version: string | null; error?: string }> {
  try {
    const res = await spawnWithTimeout([binaryPath, "--version"], { timeoutMs })
    if (res.exitCode === 0) {
      return { version: parseJbcontextVersion(res.stdout) }
    }
    if (res.timedOut) {
      return { version: null, error: `jbcontext --version timed out after ${timeoutMs}ms` }
    }
    return {
      version: null,
      error: res.stderr.trim() || `jbcontext --version exited with code ${res.exitCode}`,
    }
  } catch (err) {
    return { version: null, error: err instanceof Error ? err.message : String(err) }
  }
}

async function readJbcontextConfig(
  configDir: string
): Promise<{ hasConfigFile: boolean; configData: Record<string, unknown> | null }> {
  const configFile = Bun.file(join(configDir, "config.json"))
  const hasConfigFile = await configFile.exists()
  if (!hasConfigFile) {
    return { hasConfigFile: false, configData: null }
  }
  try {
    const configData = (await configFile.json()) as Record<string, unknown>
    return { hasConfigFile: true, configData }
  } catch {
    return { hasConfigFile: true, configData: null }
  }
}

interface ConfigMeta {
  activeVersion?: string
  agentSetups?: Record<string, unknown>
  aiAccessSelections?: Record<string, unknown>
}

function extractConfigMeta(configData: Record<string, unknown> | null): ConfigMeta {
  if (!configData) return {}

  const activeVersion =
    typeof configData.activeVersion === "string" ? configData.activeVersion : undefined

  const agentSetups =
    configData.agentSetups && typeof configData.agentSetups === "object"
      ? (configData.agentSetups as Record<string, unknown>)
      : undefined

  const aiAccessSelections =
    configData.aiAccessSelections && typeof configData.aiAccessSelections === "object"
      ? (configData.aiAccessSelections as Record<string, unknown>)
      : undefined

  return { activeVersion, agentSetups, aiAccessSelections }
}

async function checkAuthentication(
  configData: Record<string, unknown> | null,
  configDir: string
): Promise<boolean> {
  if (configData) {
    const hasAuthPins = Array.isArray(configData.jbaAuthPins) && configData.jbaAuthPins.length > 0
    const aiAccess =
      configData.aiAccessSelections && typeof configData.aiAccessSelections === "object"
        ? (configData.aiAccessSelections as Record<string, unknown>)
        : null
    const hasAiAccess = aiAccess !== null && Object.keys(aiAccess).length > 0
    if (hasAuthPins || hasAiAccess) {
      return true
    }
  }

  for (const tokenFile of TOKEN_FILES) {
    if (await Bun.file(join(configDir, tokenFile)).exists()) {
      return true
    }
  }

  return false
}

function parseProjectIndices(rawIndices: unknown): {
  indices: JbcontextProjectIndex[]
  indexed: boolean
} {
  const list = Array.isArray(rawIndices) ? rawIndices : []
  const indices: JbcontextProjectIndex[] = list.map((idx: Record<string, any>) => ({
    name: idx.indexAlias?.name ?? "unknown",
    snapshots: Array.isArray(idx.snapshots) ? idx.snapshots : [],
  }))
  const indexed = indices.length > 0 && indices.some((idx) => idx.snapshots.length > 0)
  return { indices, indexed }
}

async function queryProjectStatus(
  binaryPath: string,
  projectPath: string,
  timeoutMs: number
): Promise<{ status: JbcontextProjectStatus; error?: string }> {
  try {
    const res = await spawnWithTimeout(
      [binaryPath, "status", `--project-path=${projectPath}`, "--json-output"],
      { timeoutMs }
    )
    if (res.exitCode === 0 && res.stdout) {
      const parsed = JSON.parse(res.stdout)
      const { indices, indexed } = parseProjectIndices(parsed.indices)
      return {
        status: {
          repositoryId: parsed.repositoryId,
          repositoryUrl: parsed.repositoryUrl,
          indexed,
          indices,
          message: parsed.message,
        },
      }
    }
    const errorMsg = res.timedOut
      ? `jbcontext status timed out after ${timeoutMs}ms`
      : res.stderr.trim() || `jbcontext status exited with code ${res.exitCode}`
    return {
      status: { indexed: false, indices: [], message: errorMsg },
      error: errorMsg,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      status: { indexed: false, indices: [], message: errorMsg },
      error: errorMsg,
    }
  }
}

interface ConfiguredStateParams {
  available: boolean
  hasConfigFile: boolean
  authenticated: boolean
  agentSetups?: Record<string, unknown>
  projectStatus?: JbcontextProjectStatus
  requireProjectIndexed?: boolean
  projectPath?: string
}

function determineConfiguredState(params: ConfiguredStateParams): boolean {
  const { available, hasConfigFile, authenticated, agentSetups } = params
  const hasAgentConfigs = Boolean(agentSetups && Object.keys(agentSetups).length > 0)
  const isGloballyConfigured = hasConfigFile && (authenticated || hasAgentConfigs)
  if (!available || !isGloballyConfigured) {
    return false
  }
  if (params.requireProjectIndexed && params.projectPath) {
    return params.projectStatus ? params.projectStatus.indexed : false
  }
  return true
}

async function checkVersionIfRequested(
  binaryPath: string | null,
  options: JbcontextDetectOptions | undefined,
  timeoutMs: number
): Promise<{ version: string | null; versionError?: string }> {
  if (!binaryPath) return { version: null }
  if (options && options.checkVersion === false) return { version: null }
  const res = await queryCliVersion(binaryPath, timeoutMs)
  return { version: res.version, versionError: res.error }
}

async function checkProjectIfRequested(
  binaryPath: string | null,
  options: JbcontextDetectOptions | undefined,
  timeoutMs: number
): Promise<{ projectStatus?: JbcontextProjectStatus; projectError?: string }> {
  if (!binaryPath || !options || !options.projectPath) return {}
  if (options.checkProject === false) return {}
  const res = await queryProjectStatus(binaryPath, options.projectPath, timeoutMs)
  return { projectStatus: res.status, projectError: res.error }
}

/**
 * Quick boolean check if jbcontext binary is available on the system.
 */
export async function isJbcontextAvailable(options?: JbcontextDetectOptions): Promise<boolean> {
  const binary = await resolveJbcontextBinary(options)
  if (!binary) return false
  if (options && options.checkVersion === true) {
    const timeoutMs = resolveTimeoutMs(options)
    const res = await spawnWithTimeout([binary, "--version"], { timeoutMs })
    return res.exitCode === 0
  }
  return true
}

/**
 * Check if jbcontext is available and configured.
 */
export async function isJbcontextConfigured(options?: JbcontextDetectOptions): Promise<boolean> {
  const hasProject = options && options.projectPath !== undefined
  const result = await detectJbcontext({
    checkVersion: false,
    checkProject: hasProject,
    ...options,
  })
  return result.configured
}

/**
 * Comprehensive detection of jbcontext availability, configuration, authentication, and project index status.
 */
export async function detectJbcontext(
  options?: JbcontextDetectOptions
): Promise<JbcontextDetection> {
  const home = resolveHomeDir(options)
  const timeoutMs = resolveTimeoutMs(options)
  const binaryPath = await resolveJbcontextBinary(options)
  const available = binaryPath !== null

  const { version: cliVersion, versionError } = await checkVersionIfRequested(
    binaryPath,
    options,
    timeoutMs
  )

  const configDir = join(home, ".jbcontext")
  const { hasConfigFile, configData } = await readJbcontextConfig(configDir)
  const meta = extractConfigMeta(configData)
  const version = cliVersion || meta.activeVersion || null
  const authenticated = await checkAuthentication(configData, configDir)

  const { projectStatus, projectError } = await checkProjectIfRequested(
    binaryPath,
    options,
    timeoutMs
  )

  const configured = determineConfiguredState({
    available,
    hasConfigFile,
    authenticated,
    agentSetups: meta.agentSetups,
    projectStatus,
    requireProjectIndexed: options?.requireProjectIndexed,
    projectPath: options?.projectPath,
  })

  const error = versionError || projectError

  return {
    available,
    configured,
    binaryPath,
    version,
    configDir,
    hasConfigFile,
    authenticated,
    agentSetups: meta.agentSetups,
    activeVersion: meta.activeVersion,
    aiAccessSelections: meta.aiAccessSelections,
    project: projectStatus,
    ...(error ? { error } : {}),
  }
}

function buildIndexArgs(binary: string, options?: JbcontextIndexOptions): string[] {
  const args = [binary, "index"]
  if (options?.projectPath) {
    args.push(`--project-path=${options.projectPath}`)
  }
  if (options?.revision) {
    args.push(`--revision=${options.revision}`)
  }
  if (options?.silent !== false) {
    args.push("--silent")
  }
  return args
}

/**
 * Trigger background indexing of a project via jbcontext index.
 * Spawns a detached/unref subprocess so it does not block the caller.
 * Returns true if the index process was successfully launched.
 */
export async function triggerJbcontextIndex(options?: JbcontextIndexOptions): Promise<boolean> {
  const binary = await resolveJbcontextBinary(options)
  if (!binary) return false

  const args = buildIndexArgs(binary, options)

  try {
    const proc = Bun.spawn(args, {
      stdout: "ignore",
      stderr: "ignore",
      cwd: options?.projectPath,
    })
    proc.unref()
    return true
  } catch {
    return false
  }
}

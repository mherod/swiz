import { afterAll } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { projectKeyFromCwd } from "../project-key.ts"
import { getSessionTasksDir } from "../tasks/task-recovery.ts"
import { extractPreToolSurfaceDecision, getHookSpecificOutput } from "./hook-specific-output.ts"

/** Shared type alias for loosely-typed JSON objects in tests. */
export type JsonObject = Record<string, any>

/**
 * Result of an in-process dispatch call. Mirrors the fields tests used to
 * extract from subprocess stdout, so converting from `Bun.spawn([...dispatch])`
 * to `dispatchInProcess()` is a mechanical rename of the destructure.
 */
export interface DispatchInProcessResult {
  /** Raw response object returned by the dispatch engine. */
  response: Record<string, any>
  /** Alias for `response` — matches the `parsed` field from the old subprocess helper. */
  parsed: Record<string, any> | null
  /** JSON serialization of the response, empty string when the response is `{}`. */
  stdout: string
  /** Empty string placeholder so callers that check `result.stderr` don't crash. */
  stderr: string
  /** Always 0 for in-process success. Dispatch throws on hard failure. */
  exitCode: number | null
}

/**
 * Run `swiz dispatch <event>` in-process by calling `executeDispatch` directly.
 *
 * Replaces `Bun.spawn(["bun", "run", "index.ts", "dispatch", event], ...)` —
 * avoids ~200-300ms Bun cold-start and module-init cost per test.
 *
 * The full CLI path (`runDispatch`) reads stdin, probes the daemon, writes to
 * stdout, and calls `process.exit(0)`. None of that is useful in tests. This
 * helper skips straight to `executeDispatch(req)` which returns the response
 * object directly. Tests that previously parsed `stdout.trim()` as JSON can
 * read `result.parsed` instead.
 *
 * Payload normalization matches `runDispatch`: default `cwd` to `process.cwd()`,
 * default `session_id` to the env or "unknown-session".
 */
export async function dispatchInProcess(
  canonicalEvent: string,
  payload: JsonObject,
  opts?: { hookEventName?: string }
): Promise<DispatchInProcessResult> {
  const { executeDispatch } = await import("../dispatch/execute.ts")
  const { normalizeAgentHookPayload } = await import("../dispatch/payload-normalize.ts")
  const normalized: JsonObject = { ...payload }
  normalizeAgentHookPayload(normalized)
  if (!normalized.cwd) normalized.cwd = process.cwd()
  if (!normalized.session_id) {
    normalized.session_id = process.env.GEMINI_SESSION_ID || "unknown-session"
  }
  const hookEventName = opts?.hookEventName ?? canonicalEvent
  const { response } = await executeDispatch({
    canonicalEvent,
    hookEventName,
    payloadStr: JSON.stringify(normalized),
    preParsedPayload: normalized,
  })
  const isEmpty = Object.keys(response).length === 0
  const stdout = isEmpty ? "" : JSON.stringify(response)
  return {
    response,
    parsed: isEmpty ? null : response,
    stdout,
    stderr: "",
    exitCode: 0,
  }
}

/** Simplified hook result for tests that check blocked/allowed state. */
export interface SimpleHookResult {
  blocked: boolean
  reason: string
}

/** Extended hook result that also tracks advisory (non-blocking) hints. */
export interface AdvisoryHookResult extends SimpleHookResult {
  advisory: boolean
}

/** Write a `.swiz/state.json` file into the given directory. */
export async function writeState(dir: string, state: string): Promise<void> {
  const configDir = join(dir, ".swiz")
  await mkdir(configDir, { recursive: true })
  await Bun.write(join(configDir, "state.json"), JSON.stringify({ state }))
}

/**
 * Concurrent-safe temporary directory manager for bun tests.
 *
 * Registers an afterAll hook so directories are removed after ALL tests in the
 * file complete — not after each individual test. This prevents concurrent
 * sibling tests from having their directories deleted mid-run, which causes
 * ENOENT errors in Bun.spawn({ cwd }) calls.
 *
 * Usage:
 *   const tmp = useTempDir("swiz-my-prefix-")
 *   const dir = await tmp.create()          // uses default prefix
 *   const dir = await tmp.create("other-")  // override prefix for this dir
 */
export function useTempDir(defaultPrefix = "swiz-test-"): {
  create: (prefix?: string) => Promise<string>
} {
  const dirs: string[] = []

  afterAll(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!
      await rm(dir, { recursive: true, force: true })
    }
  })

  return {
    async create(prefix = defaultPrefix): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    },
  }
}

export interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** Parsed JSON from stdout, if parseable. */
  json?: Record<string, any> | null
  decision?: string
  reason?: string
}

/**
 * Merge `process.env` with overrides. Keys set to `undefined` are removed.
 * `HOME: undefined` becomes `HOME: ""` because Bun.spawn re-injects the real
 * home from the OS when `HOME` is omitted from the env object.
 */
function mergeHookEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }
  if (Object.hasOwn(overrides, "HOME") && overrides.HOME === undefined) {
    env.HOME = ""
  }
  return env
}

/**
 * Run a SwizHook default-export in-process without spawning a subprocess.
 *
 * Dynamic-imports the script, invokes `hook.run(payload)` inside
 * `withInlineSwizHookRun` so subprocess-only helpers (`denyPreToolUse`,
 * `emitContext`, …) redirect via `SwizHookExit` instead of calling
 * `process.exit`. Returns the same shape as the subprocess `runHook`.
 *
 * Only safe for hooks that default-export a SwizHook AND don't need env
 * overrides — mutating `process.env` under `--concurrent` would leak across
 * test files. Use `runHook` (subprocess) when either condition fails.
 */
export async function runHookInProcess(
  script: string,
  stdinPayload: Record<string, any>
): Promise<HookResult> {
  const { withInlineSwizHookRun, SwizHookExit } = await import("../inline-hook-context.ts")
  const absPath = resolve(process.cwd(), script)
  const mod = (await import(absPath)) as { default?: { run?: (input: any) => Promise<any> } }
  const hook = mod.default
  if (!hook || typeof hook.run !== "function") {
    throw new Error(`${script} does not default-export a SwizHook; use runHook() instead`)
  }
  let output: Record<string, any> | null = null
  try {
    const result = await withInlineSwizHookRun(() => hook.run!(stdinPayload))
    if (result && typeof result === "object") {
      output = result as Record<string, any>
    }
  } catch (err) {
    if (err instanceof SwizHookExit) {
      output = err.output as Record<string, any>
    } else {
      throw err
    }
  }
  const hasOutput = output !== null && Object.keys(output).length > 0
  const stdout = hasOutput ? JSON.stringify(output) : ""
  let decision: string | undefined
  let reason: string | undefined
  let json: Record<string, any> | null = null
  if (hasOutput && output) {
    json = output
    const surface = extractPreToolSurfaceDecision(output)
    decision = surface.decision
    reason = surface.reason
  }
  return { exitCode: 0, stdout, stderr: "", json, decision, reason }
}

/**
 * Run a hook script. Uses in-process execution when `envOverrides` is empty
 * and the hook default-exports a SwizHook; otherwise spawns `bun hooks/<script>`
 * to preserve env-override semantics.
 */
export async function runHook(
  script: string,
  stdinPayload: Record<string, any>,
  envOverrides: Record<string, string | undefined> = {}
): Promise<HookResult> {
  if (Object.keys(envOverrides).length === 0) {
    try {
      return await runHookInProcess(script, stdinPayload)
    } catch (err) {
      // If the hook isn't SwizHook-compatible, fall through to subprocess path.
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes("does not default-export a SwizHook")) throw err
    }
  }

  const payload = JSON.stringify(stdinPayload)
  const env = mergeHookEnv(envOverrides)

  const proc = Bun.spawn(["bun", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  let decision: string | undefined
  let reason: string | undefined
  let json: Record<string, any> | null = null

  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout.trim()) as Record<string, any>
      json = parsed
      const surface = extractPreToolSurfaceDecision(parsed)
      decision = surface.decision
      reason = surface.reason
    } catch {}
  }

  return { exitCode: proc.exitCode, stdout: stdout.trim(), stderr, json, decision, reason }
}

/**
 * Create a temp directory that looks like a real project (git repo + CLAUDE.md
 * with an old mtime) so memory-enforcement hooks fire without cooldown bypass.
 * Pass the `create` method from a `useTempDir()` instance so cleanup is managed
 * by the caller's afterAll hook.
 */
export async function createEnforcementProjectDir(makeDir: () => Promise<string>): Promise<string> {
  const dir = await makeDir()
  const init = Bun.spawn(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  await init.exited
  const claudeMd = join(dir, "CLAUDE.md")
  await writeFile(claudeMd, "# Guide\n")
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(claudeMd, twoHoursAgo, twoHoursAgo)
  return dir
}

export type BashHookRunOpts = {
  toolName?: string
  cwd?: string
  transcript_path?: string
  session_id?: string
}

function bashHookPayloadJson(command: string, opts: BashHookRunOpts): string {
  return JSON.stringify({
    tool_name: opts.toolName ?? "Bash",
    tool_input: { command },
    ...(opts.transcript_path !== undefined && { transcript_path: opts.transcript_path }),
    ...(opts.session_id !== undefined && { session_id: opts.session_id }),
  })
}

function parsePreToolUseHookStdout(stdout: string): {
  decision?: string
  reason?: string
} | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, any>
    const surface = extractPreToolSurfaceDecision(parsed)
    if (surface.decision || surface.reason) return surface

    // Codex strips explicit allow decisions from PreToolUse output. In hook
    // subprocess tests, a parsed PreToolUse envelope with no deny surface still
    // represents an allow outcome.
    const hso = getHookSpecificOutput(parsed)
    if (hso?.hookEventName === "PreToolUse") {
      return { decision: "allow" }
    }
    return surface
  } catch {
    return null
  }
}

/**
 * Run a PreToolUse Bash hook as a subprocess with a shell-command payload.
 * Used by test suites for hooks that inspect Bash commands (no-npm, banned-commands, etc.).
 */
export async function runBashHook(
  script: string,
  command: string,
  opts: BashHookRunOpts = {}
): Promise<{ decision?: string; reason?: string; stdout: string }> {
  const payload = bashHookPayloadJson(command, opts)
  const proc = Bun.spawn(["bun", resolve(script)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: { ...process.env, SWIZ_DAEMON_PORT: "19999" },
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  const stdout = out.trim()
  const parsed = parsePreToolUseHookStdout(stdout)
  if (!stdout || !parsed) return { stdout }
  return { ...parsed, stdout }
}

export interface FileEditHookResult {
  decision?: string
  reason?: string
  rawOutput: string
}

/**
 * Run a PreToolUse file-edit hook (Edit/Write) as a subprocess and parse its output.
 * Used by test suites for hooks that inspect file content (ts-ignore, eslint-disable, etc.).
 */
export async function runFileEditHook(
  script: string,
  opts: {
    filePath?: string
    oldString?: string
    newString?: string
    content?: string
    toolName?: string
  }
): Promise<FileEditHookResult> {
  const payload = JSON.stringify({
    tool_name: opts.toolName ?? "Edit",
    tool_input: {
      file_path: opts.filePath ?? "src/app.ts",
      old_string: opts.oldString,
      new_string: opts.newString,
      content: opts.content,
    },
  })

  const proc = Bun.spawn(["bun", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()

  const rawOutput = await new Response(proc.stdout).text()
  await proc.exited

  if (!rawOutput.trim()) return { rawOutput }
  try {
    const parsed = JSON.parse(rawOutput.trim()) as Record<string, any>
    const surface = extractPreToolSurfaceDecision(parsed)
    if (surface.decision || surface.reason) {
      return {
        ...surface,
        rawOutput,
      }
    }

    const hso = getHookSpecificOutput(parsed)
    return {
      ...(hso?.hookEventName === "PreToolUse" ? { decision: "allow" } : {}),
      rawOutput,
    }
  } catch {
    return { rawOutput }
  }
}

// ─── Git repo fixtures for stop-hook integration tests ──────────────────────

/** Run a git command in a directory; returns stdout trimmed. */
export async function runGit(dir: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.trim()
}

/**
 * Create a temporary git repo with optional seed commits.
 * Requires a `useTempDir` instance for lifecycle management.
 *
 * @param tmp - A `useTempDir()` instance that manages cleanup
 * @param opts
 * @param opts.suffix - Suffix appended to the temp dir prefix (default: "")
 * @param opts.seedCommits - Number of empty seed commits (default: 1)
 */
export async function makeTempGitRepo(
  tmp: ReturnType<typeof useTempDir>,
  opts: { suffix?: string; seedCommits?: number } = {}
): Promise<string> {
  const { suffix = "", seedCommits = 1 } = opts
  const dir = await tmp.create(`swiz-test-git${suffix}-`)
  await runGit(dir, ["init"])
  await runGit(dir, ["config", "user.email", "test@example.com"])
  await runGit(dir, ["config", "user.name", "Test"])
  for (let i = 0; i < seedCommits; i++) {
    await runGit(dir, ["commit", "--allow-empty", "-m", i === 0 ? "init" : `seed ${i}`])
  }
  return dir
}

/** Write a file, stage it, and create a commit. Creates parent directories as needed. */
export async function commitFile(dir: string, relPath: string, content: string): Promise<void> {
  const parts = relPath.split("/")
  if (parts.length > 1) {
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true })
  }
  await writeFile(join(dir, relPath), content)
  await runGit(dir, ["add", relPath])
  await runGit(dir, ["commit", "-m", `add ${relPath}`])
}

/** Join transcript JSONL entries into a single string for test fixtures. */
export function makeTranscript(...entries: string[]): string {
  return entries.join("\n")
}

/**
 * Create a bare git repository suitable for hook tests that inspect git state.
 * If `featureBranch` is supplied, checks out that branch before adding the remote.
 * The returned directory is NOT managed by useTempDir — callers must clean up if needed.
 */
export async function createTestRepo(
  remoteUrl: string,
  opts: { featureBranch?: string } = {}
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-test-repo-"))
  const run = (args: string[]) =>
    Bun.spawnSync(args, { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env })
  run(["git", "init"])
  run(["git", "config", "user.email", "test@example.com"])
  run(["git", "config", "user.name", "Test User"])
  await writeFile(join(dir, "README.md"), "hello\n")
  run(["git", "add", "README.md"])
  run(["git", "commit", "-m", "init"])
  run(["git", "branch", "-M", "main"])
  if (opts.featureBranch) {
    run(["git", "checkout", "-b", opts.featureBranch])
  }
  run(["git", "remote", "add", "origin", remoteUrl])
  return dir
}

/**
 * Write a stub Claude session transcript file at ~/.claude/projects/<key>/<sessionId>.jsonl.
 * Pass `content` to seed the file with specific JSONL lines; omit for an empty transcript.
 */
export async function writeClaudeSession(
  homeDir: string,
  cwd: string,
  sessionId: string,
  content = ""
): Promise<void> {
  const projectKey = projectKeyFromCwd(cwd)
  const dir = join(homeDir, ".claude", "projects", projectKey)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), content)
}

/** Write a task JSON file into ~/.claude/tasks/<sessionId>/<id>.json */
export async function writeTask(
  homeDir: string,
  sessionId: string,
  task: { id: string; subject: string; status: string }
): Promise<void> {
  const dir = getSessionTasksDir(sessionId, homeDir)
  if (!dir) throw new Error("Failed to resolve session tasks directory")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${task.id}.json`),
    JSON.stringify({ ...task, description: "", blocks: [], blockedBy: [] }, null, 2)
  )
}

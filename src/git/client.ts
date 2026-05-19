import { AsyncLocalStorage } from "node:async_hooks"
import { resolveSpawnCwd } from "../cwd.ts"

export type GitOutputMode = "pipe" | "inherit" | "ignore"

export interface GitRunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  stdout?: GitOutputMode
  stderr?: GitOutputMode
}

export interface GitCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface GitClient {
  run(args: string[], options?: GitRunOptions): Promise<GitCommandResult>
  runSync(args: string[], options?: GitRunOptions): GitCommandResult
}

type BunReadable = ReadableStream<Uint8Array> | null | undefined

const spawnOriginal = Bun.spawn.bind(Bun)
const spawnSyncOriginal = Bun.spawnSync.bind(Bun)
const gitClientStorage = new AsyncLocalStorage<GitClient>()

function gitEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...process.env, ...overrides }
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || key.startsWith("GIT_")) continue
    cleaned[key] = value
  }
  return cleaned
}

async function readStream(stream: BunReadable): Promise<string> {
  if (!stream) return ""
  return await new Response(stream).text()
}

function decodeBytes(bytes: Uint8Array | ArrayBuffer | undefined): string {
  if (!bytes) return ""
  return new TextDecoder().decode(bytes)
}

export class BunGitClient implements GitClient {
  async run(args: string[], options: GitRunOptions = {}): Promise<GitCommandResult> {
    const stdoutMode = options.stdout ?? "pipe"
    const stderrMode = options.stderr ?? "pipe"
    const proc = spawnOriginal(["git", ...args], {
      cwd: resolveSpawnCwd(options.cwd ?? process.cwd()),
      stdout: stdoutMode,
      stderr: stderrMode,
      env: gitEnv(options.env),
    })

    const [stdout, stderr] = await Promise.all([
      stdoutMode === "pipe" ? readStream(proc.stdout) : Promise.resolve(""),
      stderrMode === "pipe" ? readStream(proc.stderr) : Promise.resolve(""),
    ])
    await proc.exited
    return { stdout, stderr, exitCode: proc.exitCode ?? 1 }
  }

  runSync(args: string[], options: GitRunOptions = {}): GitCommandResult {
    const stdoutMode = options.stdout ?? "pipe"
    const stderrMode = options.stderr ?? "pipe"
    const proc = spawnSyncOriginal(["git", ...args], {
      cwd: resolveSpawnCwd(options.cwd ?? process.cwd()),
      stdout: stdoutMode,
      stderr: stderrMode,
      env: gitEnv(options.env),
    })
    return {
      stdout: stdoutMode === "pipe" ? decodeBytes(proc.stdout) : "",
      stderr: stderrMode === "pipe" ? decodeBytes(proc.stderr) : "",
      exitCode: proc.exitCode ?? 1,
    }
  }
}

const defaultGitClient = new BunGitClient()

export function getGitClient(): GitClient {
  return gitClientStorage.getStore() ?? defaultGitClient
}

export async function withGitClient<T>(
  client: GitClient,
  fn: () => T | Promise<T>
): Promise<Awaited<T>> {
  return await gitClientStorage.run(client, async () => await fn())
}

export function withGitClientSync<T>(client: GitClient, fn: () => T): T {
  return gitClientStorage.run(client, fn)
}

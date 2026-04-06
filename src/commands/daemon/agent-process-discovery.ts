/**
 * OS process introspection for Claude/Codex/Gemini/Cursor agent PIDs: `ps`, `lsof`,
 * provider classification, and a short-TTL snapshot cache. Used by the daemon web
 * server and session routes — kept separate from HTTP routing.
 */

import type { AgentProcessSnapshot } from "./session-routes.ts"

export function isCursorMacProcess(command: string): boolean {
  return command.includes("cursor.app/contents/macos/cursor")
}

export async function getProcessCommand(pid: number): Promise<string | null> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) return null
  const command = stdout.trim().toLowerCase()
  return command.length > 0 ? command : null
}

function parseLsofCwdOutput(lsofOut: string): Record<number, string> {
  const pidCwds: Record<number, string> = {}
  let currentPid = 0
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = parseInt(line.slice(1), 10)
    } else if (line.startsWith("n") && currentPid > 0) {
      pidCwds[currentPid] = line.slice(1)
    }
  }
  return pidCwds
}

async function resolvePidCwds(allPids: number[]): Promise<Record<number, string>> {
  const pidCwds: Record<number, string> = {}
  const chunkSize = 120
  for (let i = 0; i < allPids.length; i += chunkSize) {
    const pidChunk = allPids.slice(i, i + chunkSize)
    try {
      const lsofProc = Bun.spawn(["lsof", "-p", pidChunk.join(","), "-d", "cwd", "-Fn"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      let lsofTimedOut = false
      const killTimer = setTimeout(() => {
        lsofTimedOut = true
        lsofProc.kill()
      }, 3000)
      try {
        const [lsofOut] = await Promise.all([
          new Response(lsofProc.stdout).text(),
          new Response(lsofProc.stderr).text(),
        ])
        await lsofProc.exited
        if (!lsofTimedOut) Object.assign(pidCwds, parseLsofCwdOutput(lsofOut))
      } finally {
        clearTimeout(killTimer)
      }
    } catch {
      // lsof not found on PATH or spawn failed — skip cwd resolution gracefully
      break
    }
  }
  return pidCwds
}

/** Pluggable provider classifier — order matters (first match wins). */
export interface ProviderClassifier {
  id: string
  match: (command: string, executable: string) => boolean
}

/** Registry of provider classifiers. Add new providers here instead of editing an if-chain. */
export const PROVIDER_CLASSIFIERS: ProviderClassifier[] = [
  { id: "claude", match: (cmd) => cmd.includes("claude-agent-sdk/cli.js") },
  { id: "codex", match: (cmd) => cmd.includes("/codex") || cmd.includes(" codex ") },
  { id: "gemini", match: (cmd) => cmd.includes("gemini") },
  {
    id: "cursor",
    match: (cmd, exe) => isCursorMacProcess(cmd) || exe === "agent" || exe.endsWith("/agent"),
  },
]

function classifyProviderPid(command: string, executable: string): string | null {
  for (const classifier of PROVIDER_CLASSIFIERS) {
    if (classifier.match(command, executable)) return classifier.id
  }
  return null
}

function parseProviderPids(stdout: string): Map<string, Set<number>> {
  const providers = new Map<string, Set<number>>()
  for (const row of stdout.split("\n")) {
    const trimmed = row.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const command = (match[2] ?? "").toLowerCase()
    const executable = command.split(/\s+/, 1)[0] ?? ""
    if (!pid || !command) continue

    const provider = classifyProviderPid(command, executable)
    if (!provider) continue
    const existing = providers.get(provider) ?? new Set<number>()
    existing.add(pid)
    providers.set(provider, existing)
  }
  return providers
}

export async function getActiveAgentProcesses(): Promise<AgentProcessSnapshot> {
  try {
    const proc = Bun.spawn(["ps", "-Ao", "pid,command"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) return { providers: {}, pidCwds: {} }

    const providers = parseProviderPids(stdout)

    const allPids: number[] = []
    for (const pids of providers.values()) {
      for (const pid of pids) allPids.push(pid)
    }

    const pidCwds = allPids.length > 0 ? await resolvePidCwds(allPids) : {}

    const snapshot: Record<string, number[]> = {}
    for (const [provider, pids] of providers) {
      snapshot[provider] = [...pids].sort((a, b) => a - b)
    }
    return { providers: snapshot, pidCwds }
  } catch {
    return { providers: {}, pidCwds: {} }
  }
}

// ─── Agent process snapshot cache ──────────────────────────────────────────
// Short-TTL cache with in-flight coalescing. Avoids redundant ps+lsof scans
// when multiple routes request the snapshot concurrently or within the TTL.

const AGENT_PROCESS_CACHE_TTL_MS = 3_000

let cachedSnapshot: AgentProcessSnapshot | null = null
let cachedAt = 0
let inflight: Promise<AgentProcessSnapshot> | null = null

export async function getCachedAgentProcesses(): Promise<AgentProcessSnapshot> {
  if (cachedSnapshot && Date.now() - cachedAt < AGENT_PROCESS_CACHE_TTL_MS) {
    return cachedSnapshot
  }
  if (inflight) return inflight
  inflight = getActiveAgentProcesses().then((snapshot) => {
    cachedSnapshot = snapshot
    cachedAt = Date.now()
    inflight = null
    return snapshot
  })
  return inflight
}

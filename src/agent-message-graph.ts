/**
 * Which agent sessions talk to each other, and across which projects.
 *
 * Inter-agent `SendMessage` calls are the only first-class evidence that two sessions are
 * collaborating. Nothing else records it: the task stores are per-project, the transcripts are
 * per-session, and a message leaves no trace in either. Without this, "session A and session B
 * worked on the same thing" is only recoverable by reading two transcripts side by side.
 *
 * The sender is exact — `session_id` and `cwd` arrive in the hook payload. The recipient is an
 * address the sender typed, so it is resolved rather than known:
 *
 *   uds:/tmp/cc-socks/33626.sock   a socket whose basename is the peer's PID
 *   openai-sba-dashboard-c6        a peer name whose prefix is the project's directory basename
 *
 * Resolution is deliberately *not* done at capture time. Mapping a PID to a cwd means `lsof` or a
 * process snapshot, and a PostToolUse hook runs on every matching tool call — paying that cost
 * per message to enrich a log nobody may read is the wrong trade. The hook appends the raw
 * address; {@link resolveRecipient} interprets it when the graph is actually built, by which
 * point the reader already has the project list and process table it needs.
 *
 * No message content is stored. Only the byte length is kept, matching the sanitisation the
 * incoming-capture JSONL already applies — an association graph needs to know that two sessions
 * exchanged 3kB, not what they said.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { getHomeDir } from "./home.ts"

/** One recorded message, as appended by the hook. Content is never included. */
export interface AgentMessageEdge {
  /** ISO timestamp of the send. */
  at: string
  /** Sending session id — exact, from the hook payload. */
  fromSessionId: string
  /** Sending project directory — exact, from the hook payload. */
  fromCwd: string
  /** The recipient address exactly as the sender wrote it. */
  toAddress: string
  /** Size of the message body in bytes. The body itself is not stored. */
  messageBytes: number
}

export type ParsedRecipient =
  | { kind: "socket"; raw: string; pid: number }
  | { kind: "name"; raw: string; name: string }
  | { kind: "unknown"; raw: string }

/** `uds:/tmp/cc-socks/33626.sock` and friends — the basename is the peer process id. */
const SOCKET_ADDRESS_RE = /^(?:uds:)?(\/.*\/)?(\d+)\.sock$/

/**
 * Classify a recipient address without resolving it.
 *
 * Pure and dependency-free so the hook can call it on the hot path; the expensive half lives in
 * {@link resolveRecipient}.
 */
export function parseRecipient(address: string): ParsedRecipient {
  const raw = address.trim()
  if (!raw) return { kind: "unknown", raw: address }
  const socket = SOCKET_ADDRESS_RE.exec(raw)
  if (socket) return { kind: "socket", raw, pid: Number(socket[2]) }
  // A bare name. Anything else (an agent id, "main", a teammate label) is still a name as far as
  // the graph is concerned — it identifies a peer, it just may not resolve to a project.
  return { kind: "name", raw, name: raw }
}

/** What a recipient address turned out to point at, as far as can be determined. */
export interface ResolvedRecipient {
  parsed: ParsedRecipient
  /** Project directory the recipient is working in, when it could be determined. */
  cwd: string | null
  /** How the cwd was arrived at — useful because two of these are inferential. */
  via: "pid" | "name-prefix" | "unresolved"
}

export interface ResolveOptions {
  /** Project directories swiz already knows about, for name-prefix matching. */
  knownProjectCwds: readonly string[]
  /** PID → cwd, e.g. the daemon's agent process snapshot. */
  pidCwds?: Readonly<Record<number | string, string>>
}

function cwdOfPid(pid: number, pidCwds: ResolveOptions["pidCwds"]): string | null {
  const cwd = pidCwds?.[pid] ?? pidCwds?.[String(pid)] ?? null
  // A cwd of "/" means the process table had no useful answer, not that the peer works at root.
  return cwd && cwd !== "/" ? cwd : null
}

/**
 * The project whose directory basename is the longest prefix of `name`.
 *
 * Matched against real candidates rather than by stripping a suffix off the name: project
 * directories legitimately contain hyphens, so "openai-sba-dashboard-c6" cannot be split
 * correctly without knowing them. Longest wins, picking `openai-sba-dashboard` over `openai`.
 */
function cwdOfName(name: string, knownProjectCwds: readonly string[]): string | null {
  let best: string | null = null
  for (const candidate of knownProjectCwds) {
    const projectName = basename(candidate)
    if (!projectName || !name.startsWith(projectName)) continue
    if (!best || projectName.length > basename(best).length) best = candidate
  }
  return best
}

/** Resolve an address to a project directory, as far as the available evidence allows. */
export function resolveRecipient(
  parsed: ParsedRecipient,
  options: ResolveOptions
): ResolvedRecipient {
  if (parsed.kind === "socket") {
    const cwd = cwdOfPid(parsed.pid, options.pidCwds)
    return { parsed, cwd, via: cwd ? "pid" : "unresolved" }
  }
  if (parsed.kind === "name") {
    const cwd = cwdOfName(parsed.name, options.knownProjectCwds)
    return { parsed, cwd, via: cwd ? "name-prefix" : "unresolved" }
  }
  return { parsed, cwd: null, via: "unresolved" }
}

// ─── Store ──────────────────────────────────────────────────────────────────

/** Append-only, in ~/.swiz so the graph outlives /tmp cleanup and daemon restarts. */
export function agentMessageLogPath(home = getHomeDir()): string {
  return join(home, ".swiz", "agent-messages.jsonl")
}

/** Append one edge. Fail-open: a capture miss must never break the tool call that triggered it. */
export async function recordAgentMessage(
  edge: AgentMessageEdge,
  logPath = agentMessageLogPath()
): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, `${JSON.stringify(edge)}\n`)
  } catch {
    // Best-effort telemetry.
  }
}

export async function readAgentMessages(
  logPath = agentMessageLogPath()
): Promise<AgentMessageEdge[]> {
  let text: string
  try {
    text = await readFile(logPath, "utf-8")
  } catch {
    return []
  }
  const edges: AgentMessageEdge[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      edges.push(JSON.parse(line) as AgentMessageEdge)
    } catch {
      // A torn final line from a concurrent append is expected; skip it.
    }
  }
  return edges
}

// ─── Graph ──────────────────────────────────────────────────────────────────

export interface ProjectLink {
  fromCwd: string
  /** Null when the recipient address could not be resolved to a project. */
  toCwd: string | null
  messageCount: number
  totalBytes: number
  firstAt: string
  lastAt: string
  /** Sessions observed sending on this link. */
  fromSessionIds: string[]
  /** Recipient addresses observed on this link, as written. */
  toAddresses: string[]
}

function linkKey(fromCwd: string, toCwd: string | null, toAddress: string): string {
  // Unresolved recipients key by address so two different unknown peers stay distinct.
  return `${fromCwd}\u0000${toCwd ?? `?${toAddress}`}`
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

/**
 * Collapse the edge log into project-to-project links.
 *
 * Self-links are kept rather than filtered: two sessions in the same project messaging each other
 * is a real collaboration and the thing a reader most wants to see when a project has several
 * agents on it.
 */
export function buildProjectLinks(
  edges: readonly AgentMessageEdge[],
  options: ResolveOptions
): ProjectLink[] {
  const links = new Map<string, ProjectLink>()
  for (const edge of edges) {
    const resolved = resolveRecipient(parseRecipient(edge.toAddress), options)
    const key = linkKey(edge.fromCwd, resolved.cwd, edge.toAddress)
    const existing = links.get(key)
    if (existing) {
      existing.messageCount++
      existing.totalBytes += edge.messageBytes
      if (edge.at < existing.firstAt) existing.firstAt = edge.at
      if (edge.at > existing.lastAt) existing.lastAt = edge.at
      pushUnique(existing.fromSessionIds, edge.fromSessionId)
      pushUnique(existing.toAddresses, edge.toAddress)
      continue
    }
    links.set(key, {
      fromCwd: edge.fromCwd,
      toCwd: resolved.cwd,
      messageCount: 1,
      totalBytes: edge.messageBytes,
      firstAt: edge.at,
      lastAt: edge.at,
      fromSessionIds: [edge.fromSessionId],
      toAddresses: [edge.toAddress],
    })
  }
  return [...links.values()].sort((a, b) => b.messageCount - a.messageCount)
}

/** Project directories that exchanged messages with `cwd`, in either direction. */
export function relatedProjects(links: readonly ProjectLink[], cwd: string): string[] {
  const related: string[] = []
  for (const link of links) {
    if (link.fromCwd === cwd && link.toCwd && link.toCwd !== cwd) pushUnique(related, link.toCwd)
    if (link.toCwd === cwd && link.fromCwd !== cwd) pushUnique(related, link.fromCwd)
  }
  return related.sort()
}

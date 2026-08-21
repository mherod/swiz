/**
 * Which peer sessions are still owed a reply.
 *
 * A gate on `SendMessage` can only ever catch a message being sent. The failure that actually
 * costs a pair is the opposite one: a peer asks a blocking question and the receiver works
 * straight through without answering. Silence is indistinguishable, from the sender's side, from
 * "never saw it" and from "declined" — so it stalls the peer or sends them off on a guess.
 *
 * Nothing else records it. The message graph (`agent-message-graph.ts`) records sends, so a
 * session that never replies leaves no edge at all — the absence is the signal, and an absence
 * cannot be appended to a log. The transcript is the only place both directions appear:
 *
 *   inbound   a delivered peer message, carrying `from-name` and `from` attributes
 *   outbound  an assistant `tool_use` block naming the SendMessage tool
 *
 * Reading them in order gives, per peer, whether the last thing that happened was them talking
 * to us or us talking to them.
 *
 * One delivery writes several transcript records (a queue operation, an attachment, and a user
 * message), so events are not counted — only the latest line per direction per peer is kept, and
 * duplicates collapse into it harmlessly.
 */

import { z } from "zod"

/** The peer-message tag, built at runtime so this file does not match its own detector. */
const INBOUND_TAG_RE = new RegExp(`<cross${"-"}session-message([^>]*)>`, "g")

/** `from-name="peer"` — tolerating the backslash escaping a JSON transcript line applies. */
const FROM_NAME_RE = /from-name=\\?"([^"\\]+)/
/** `from="uds:/tmp/cc-socks/1234.sock"` — the routable address, distinct from the display name. */
const FROM_ADDRESS_RE = /\bfrom=\\?"([^"\\]+)/

/** A peer whose message has not been answered. */
export interface UnansweredPeer {
  /** Display name as the delivery reported it (`from-name`). */
  peer: string
  /** Routable address (`from`), when the delivery carried one. */
  address: string | null
  /** Transcript line index of the most recent unanswered message. */
  receivedAtLine: number
  /** Assistant tool calls made since that message arrived — a proxy for "worked straight through". */
  toolCallsSince: number
}

interface PeerState {
  peer: string
  address: string | null
  lastInboundLine: number
  lastOutboundLine: number
}

/**
 * Normalise an address for comparison.
 *
 * A reply may be addressed by display name or by socket address, and `ListAgents` rows carry a
 * ` [ref]` suffix that senders copy verbatim. All three forms mean the same peer.
 */
function normalizeAddress(value: string): string {
  return value
    .trim()
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .toLowerCase()
}

function readInbound(line: string): { peer: string; address: string | null } | null {
  INBOUND_TAG_RE.lastIndex = 0
  const tag = INBOUND_TAG_RE.exec(line)
  if (!tag) return null
  const attrs = tag[1] ?? ""
  const peer = FROM_NAME_RE.exec(attrs)?.[1]?.trim()
  if (!peer) return null
  const address = FROM_ADDRESS_RE.exec(attrs)?.[1]?.trim() ?? null
  return { peer, address }
}

/** The fragment of a transcript record this scan reads; everything else passes through. */
const contentBlockSchema = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  input: z.looseObject({ to: z.string().optional() }).optional(),
})

const transcriptRecordSchema = z.looseObject({
  message: z
    .looseObject({
      content: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
    })
    .optional(),
})

type TranscriptRecord = z.infer<typeof transcriptRecordSchema>

/** Parse one JSONL line, or null when it is not a record this scan can read. */
function parseTranscriptRecord(line: string): TranscriptRecord | null {
  try {
    const parsed = transcriptRecordSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    // A truncated tail is normal on a live transcript; skip the line rather than blinding the scan.
    return null
  }
}

/** Tool-use blocks on one record, or an empty list when the content is not block-structured. */
function toolUseBlocks(record: TranscriptRecord): z.infer<typeof contentBlockSchema>[] {
  const content = record.message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block) => block.type === "tool_use")
}

/** Recipients of every SendMessage tool call on one transcript line. */
function readOutboundRecipients(record: TranscriptRecord): string[] {
  const recipients: string[] = []
  for (const block of toolUseBlocks(record)) {
    if (block.name !== "SendMessage") continue
    const to = block.input?.to
    if (typeof to === "string" && to.trim()) recipients.push(to)
  }
  return recipients
}

/** Note a delivered peer message, creating the peer's state on first sight. */
function recordInbound(
  states: Map<string, PeerState>,
  inbound: { peer: string; address: string | null },
  line: number
): void {
  const key = normalizeAddress(inbound.peer)
  const existing = states.get(key)
  if (existing) {
    existing.lastInboundLine = line
    existing.address = inbound.address ?? existing.address
    return
  }
  states.set(key, {
    peer: inbound.peer,
    address: inbound.address,
    lastInboundLine: line,
    lastOutboundLine: -1,
  })
}

/** Note a reply, matching by display name or routable address — a sender may use either. */
function recordOutbound(
  states: Map<string, PeerState>,
  recipients: readonly string[],
  line: number
): void {
  for (const recipient of recipients) {
    const target = normalizeAddress(recipient)
    for (const state of states.values()) {
      const matchesName = normalizeAddress(state.peer) === target
      const matchesAddress = state.address ? normalizeAddress(state.address) === target : false
      if (matchesName || matchesAddress) state.lastOutboundLine = line
    }
  }
}

/**
 * Peers whose most recent message is still unanswered, oldest first.
 *
 * Lines are raw transcript JSONL lines. Unparseable lines are skipped rather than failing the
 * scan: a truncated tail is normal on a live transcript and must not blind the whole check.
 */
export function findUnansweredPeerMessages(lines: readonly string[]): UnansweredPeer[] {
  const states = new Map<string, PeerState>()
  const toolUsesAtLine: number[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line?.trim()) {
      toolUsesAtLine.push(0)
      continue
    }

    const inbound = readInbound(line)
    if (inbound) recordInbound(states, inbound, i)

    const record = parseTranscriptRecord(line)
    if (!record) {
      toolUsesAtLine.push(0)
      continue
    }

    toolUsesAtLine.push(toolUseBlocks(record).length)
    recordOutbound(states, readOutboundRecipients(record), i)
  }

  const unanswered: UnansweredPeer[] = []
  for (const state of states.values()) {
    if (state.lastOutboundLine >= state.lastInboundLine) continue
    let toolCallsSince = 0
    for (let i = state.lastInboundLine + 1; i < toolUsesAtLine.length; i++) {
      toolCallsSince += toolUsesAtLine[i] ?? 0
    }
    unanswered.push({
      peer: state.peer,
      address: state.address,
      receivedAtLine: state.lastInboundLine,
      toolCallsSince,
    })
  }

  return unanswered.sort((a, b) => a.receivedAtLine - b.receivedAtLine)
}

/**
 * The reminder text, or null when nothing is owed.
 *
 * `minToolCalls` buys the session room to answer inside its current turn: a reminder that fires
 * on the very next tool call would nag a receiver who is already composing the reply.
 */
export function formatUnansweredPeerContext(
  unanswered: readonly UnansweredPeer[],
  minToolCalls = 3
): string | null {
  const due = unanswered.filter((entry) => entry.toolCallsSince >= minToolCalls)
  if (due.length === 0) return null

  const lines = due.map(
    (entry) =>
      `  - ${entry.peer}${entry.address ? ` (${entry.address})` : ""} — ${entry.toolCallsSince} tool calls ago, no reply sent`
  )
  const subject = due.length === 1 ? "A peer session is" : `${due.length} peer sessions are`

  return [
    `${subject} still waiting on a reply:`,
    ...lines,
    "",
    "Silence is the failure, not delay — a peer cannot tell 'working on it' from 'never saw it' from 'declined',",
    "so it will either stall or proceed on a guess. Send the answer, or a holding reply naming what you are",
    "mid-way through and when you will come back. Reply with SendMessage to the name or address above.",
  ].join("\n")
}

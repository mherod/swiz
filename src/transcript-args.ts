import { resolve } from "node:path"
import { AGENTS, type AgentDef } from "./agents.ts"
import { getTranscriptProvidersForAgent, type TranscriptProviderId } from "./provider-adapters.ts"
import {
  findAllProviderSessions,
  isUnsupportedTranscriptFormat,
  type Session,
} from "./transcript-utils.ts"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TranscriptArgs {
  sessionQuery: string | null
  targetDir: string
  listOnly: boolean
  headCount: number | undefined
  tailCount: number | undefined
  hours: number | undefined
  since: number | undefined
  until: number | undefined
  autoReply: boolean
  includeDebug: boolean
  userOnly: boolean
  allAgents: boolean
  explicitAgents: AgentDef[]
}

export interface TimeRange {
  from?: number
  to?: number
}

// ─── Arg parsing internals ──────────────────────────────────────────────────

function consumeValueArg(
  args: string[],
  i: number,
  longFlag: string,
  shortFlag: string
): { value: string; skip: boolean } | null {
  const arg = args[i]
  if (arg !== longFlag && arg !== shortFlag) return null
  const next = args[i + 1]
  return next ? { value: next, skip: true } : null
}

const TRANSCRIPT_BOOLEAN_FLAGS: Record<string, string> = {
  "--list": "listOnly",
  "-l": "listOnly",
  "--auto-reply": "autoReply",
  "--include-debug": "includeDebug",
  "--user-only": "userOnly",
  "--all": "allAgents",
}

type ValueArgDef = [longFlag: string, shortFlag: string]

const TRANSCRIPT_VALUE_ARGS: ValueArgDef[] = [
  ["--session", "-s"],
  ["--dir", "-d"],
  ["--head", "-H"],
  ["--tail", "-T"],
  ["--hours", "-h"],
  ["--since", "-S"],
  ["--until", "-U"],
]

function parseTranscriptValueArgs(args: string[]): {
  flags: Record<string, boolean>
  values: Record<string, string>
} {
  const flags: Record<string, boolean> = {}
  const values: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const flagKey = TRANSCRIPT_BOOLEAN_FLAGS[arg]
    if (flagKey) {
      flags[flagKey] = true
      continue
    }
    for (const [longFlag, shortFlag] of TRANSCRIPT_VALUE_ARGS) {
      const result = consumeValueArg(args, i, longFlag, shortFlag)
      if (result) {
        values[longFlag] = result.value
        i++
        break
      }
    }
  }
  return { flags, values }
}

function parseHoursValue(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --hours value: ${raw}. Must be a positive number.`)
  }
  return n
}

function parseDateValue(raw: string | undefined, flag: string): number | undefined {
  if (!raw) return undefined
  const ms = new Date(raw).getTime()
  if (!Number.isFinite(ms)) {
    throw new Error(
      `Invalid ${flag} value: ${raw}. Must be a valid date (e.g. 2026-03-12 or 2026-03-12T14:00:00).`
    )
  }
  return ms
}

function parseDateRange(
  sinceRaw: string | undefined,
  untilRaw: string | undefined
): { since: number | undefined; until: number | undefined } {
  const since = parseDateValue(sinceRaw, "--since")
  const until = parseDateValue(untilRaw, "--until")
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("--since must be before --until.")
  }
  return { since, until }
}

// ─── Public arg parsing ─────────────────────────────────────────────────────

export function parseTranscriptArgs(args: string[]): TranscriptArgs {
  const { flags, values } = parseTranscriptValueArgs(args)
  const explicitAgents = AGENTS.filter((agent) => args.includes(`--${agent.id}`))
  const { since, until } = parseDateRange(values["--since"], values["--until"])
  return {
    sessionQuery: values["--session"] ?? null,
    targetDir: values["--dir"] ? resolve(values["--dir"]) : process.cwd(),
    listOnly: flags.listOnly ?? false,
    headCount: values["--head"] ? parseInt(values["--head"], 10) : undefined,
    tailCount: values["--tail"] ? parseInt(values["--tail"], 10) : undefined,
    hours: parseHoursValue(values["--hours"]),
    since,
    until,
    autoReply: flags.autoReply ?? false,
    includeDebug: flags.includeDebug ?? false,
    userOnly: flags.userOnly ?? false,
    allAgents: flags.allAgents ?? false,
    explicitAgents,
  }
}

export function validateTranscriptArgs(parsed: TranscriptArgs): void {
  if (parsed.allAgents && parsed.explicitAgents.length > 0) {
    throw new Error("`--all` cannot be combined with an explicit agent flag.")
  }
  if (parsed.explicitAgents.length > 1) {
    throw new Error("Specify at most one agent: --claude, --cursor, --gemini, --codex, or --junie.")
  }
  if (parsed.userOnly && parsed.includeDebug) {
    throw new Error("`--user-only` cannot be combined with `--include-debug`.")
  }
  if (parsed.hours !== undefined && (parsed.since !== undefined || parsed.until !== undefined)) {
    throw new Error("`--hours` cannot be combined with `--since` or `--until`.")
  }
}

// ─── Session and provider resolution ────────────────────────────────────────

export function resolveSelectedAgents(
  allAgents: boolean,
  explicitAgents: AgentDef[],
  detectedAgent: AgentDef | null
): AgentDef[] {
  if (allAgents) return AGENTS
  if (explicitAgents[0]) return [explicitAgents[0]]
  if (detectedAgent) return [detectedAgent]
  return AGENTS
}

export function getSelectedProviders(selectedAgents: AgentDef[]): Set<TranscriptProviderId> {
  const providers = new Set<TranscriptProviderId>()
  for (const agent of selectedAgents) {
    for (const provider of getTranscriptProvidersForAgent(agent)) {
      providers.add(provider)
    }
  }
  return providers
}

export function validateProviders(
  providers: Set<TranscriptProviderId>,
  selectedAgents: AgentDef[]
): void {
  if (providers.size === 0) {
    const agentLabel = selectedAgents[0]?.name ?? "selected agent"
    throw new Error(
      `${agentLabel} transcript discovery is not supported yet.\nUse --all or --claude/--gemini/--codex/--junie.`
    )
  }
}

export function pickSession(sessions: Session[], sessionQuery: string | null): Session {
  if (sessionQuery) {
    const match = sessions.find((session) => session.id.startsWith(sessionQuery))
    if (!match) {
      const available = sessions.map((session) => `  ${session.id}`).join("\n")
      throw new Error(`No session matching: ${sessionQuery}\nAvailable sessions:\n${available}`)
    }
    return match
  }
  return sessions.find((session) => !isUnsupportedTranscriptFormat(session.format)) ?? sessions[0]!
}

export async function loadFilteredSessions(
  targetDir: string,
  selectedProviders: Set<TranscriptProviderId>
): Promise<Session[]> {
  const allProviderSessions = await findAllProviderSessions(targetDir)
  const sessions = allProviderSessions.filter(
    (session) => !!session.provider && selectedProviders.has(session.provider)
  )
  if (sessions.length === 0) {
    const checkedProviders = [...selectedProviders].join(", ")
    throw new Error(
      `No transcripts found for: ${targetDir}\n(checked providers: ${checkedProviders})`
    )
  }
  return sessions
}

// ─── Time range helpers ─────────────────────────────────────────────────────

export function buildTimeRange(parsed: TranscriptArgs): TimeRange {
  const from = parsed.hours ? Date.now() - parsed.hours * 3600_000 : parsed.since
  return { from, to: parsed.until }
}

export function filterSessionsByTime(sessions: Session[], range: TimeRange): Session[] {
  return sessions.filter((s) => {
    if (range.from !== undefined && s.mtime < range.from) return false
    if (range.to !== undefined && s.mtime > range.to) return false
    return true
  })
}

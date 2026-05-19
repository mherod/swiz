/**
 * GitHub API rate-limit budget tracker.
 *
 * GitHub is the authority for the per-token budget. We keep an in-memory view
 * fresh from `X-RateLimit-*` headers observed on the real `gh api --include`
 * calls Swiz already makes. Cold starts fetch `/rate_limit` once so we use real
 * per-token budget data before falling back.
 */

const DEFAULT_LIMIT = 5000
const DEFAULT_RESET_WINDOW_MS = 60 * 60 * 1000
const GH_RATE_LIMIT_ENDPOINT = "rate_limit"
const GH_RATE_LIMIT_JQ_QUERY = ".resources.core"

interface RateLimitBudget {
  limit: number
  remaining: number
  resetAt: number
  updatedAt: number
}

interface ParsedRateLimitHeaders {
  limit: number | null
  remaining: number | null
  resetAt: number | null
  retryAfterUntil: number | null
}

export interface ParsedGhApiIncludeOutput {
  status: number | null
  headers: Record<string, string>
  body: string
}

let budget: RateLimitBudget | null = null
let retryAfterUntil = 0
let bootstrapInProgress: Promise<void> | null = null

function currentEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function parseInteger(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value) return null
  const seconds = parseInteger(value)
  if (seconds !== null) return now + Math.max(0, seconds) * 1000
  const asDate = Date.parse(value)
  return Number.isFinite(asDate) ? asDate : null
}

function lastHttpHeaderStart(output: string): number {
  let lastIndex = -1
  for (const match of output.matchAll(/^HTTP\/\S+\s+\d{3}.*$/gm)) {
    lastIndex = match.index ?? -1
  }
  return lastIndex
}

export function parseGhApiIncludeOutput(output: string): ParsedGhApiIncludeOutput {
  const normalized = output.replace(/\r\n/g, "\n")
  const headerStart = lastHttpHeaderStart(normalized)
  if (headerStart < 0) return { status: null, headers: {}, body: output }

  const headerEnd = normalized.indexOf("\n\n", headerStart)
  if (headerEnd < 0) return { status: null, headers: {}, body: output }

  const headerBlock = normalized.slice(headerStart, headerEnd)
  const body = normalized.slice(headerEnd + 2)
  const [statusLine = "", ...headerLines] = headerBlock.split("\n")
  const status = parseInteger(statusLine.match(/^HTTP\/\S+\s+(\d{3})/)?.[1])
  const headers: Record<string, string> = {}

  for (const line of headerLines) {
    const separator = line.indexOf(":")
    if (separator < 0) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (name) headers[name] = value
  }

  return { status, headers, body }
}

function setFallbackBudget(now = Date.now()): void {
  budget = {
    limit: DEFAULT_LIMIT,
    remaining: DEFAULT_LIMIT,
    resetAt: now + DEFAULT_RESET_WINDOW_MS,
    updatedAt: now,
  }
}

async function bootstrapBudget(): Promise<void> {
  try {
    const proc = Bun.spawn(
      ["gh", "api", "--include", GH_RATE_LIMIT_ENDPOINT, "--jq", GH_RATE_LIMIT_JQ_QUERY],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: currentEnv(),
      }
    )
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) {
      return
    }
    observeGhApiIncludeOutput(stdout)
    if (!budget) {
      setFallbackBudget()
    }
  } catch {
    return
  }
}

function parseRateLimitHeaders(
  headers: Record<string, string>,
  now: number
): ParsedRateLimitHeaders {
  const resetSeconds = parseInteger(headers["x-ratelimit-reset"])
  return {
    limit: parseInteger(headers["x-ratelimit-limit"]),
    remaining: parseInteger(headers["x-ratelimit-remaining"]),
    resetAt: resetSeconds === null ? null : resetSeconds * 1000,
    retryAfterUntil: parseRetryAfter(headers["retry-after"], now),
  }
}

function hasBudgetHeaders(parsed: ParsedRateLimitHeaders): boolean {
  return parsed.limit !== null || parsed.remaining !== null || parsed.resetAt !== null
}

function applyRetryAfter(nextRetryAfterUntil: number | null): void {
  if (nextRetryAfterUntil === null) return
  retryAfterUntil = Math.max(retryAfterUntil, nextRetryAfterUntil)
}

function nextBudgetFromHeaders(parsed: ParsedRateLimitHeaders, now: number): RateLimitBudget {
  const nextLimit = Math.max(1, parsed.limit ?? budget?.limit ?? DEFAULT_LIMIT)
  const nextRemaining = Math.max(0, parsed.remaining ?? budget?.remaining ?? nextLimit)
  return {
    limit: nextLimit,
    remaining: Math.min(nextLimit, nextRemaining),
    resetAt: parsed.resetAt ?? budget?.resetAt ?? now + DEFAULT_RESET_WINDOW_MS,
    updatedAt: now,
  }
}

function applyHeaders(headers: Record<string, string>, now = Date.now()): void {
  const parsed = parseRateLimitHeaders(headers, now)
  applyRetryAfter(parsed.retryAfterUntil)
  if (!hasBudgetHeaders(parsed)) return
  budget = nextBudgetFromHeaders(parsed, now)
}

export function observeGhRateLimitHeaders(headers: Record<string, string>): void {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value
  }
  applyHeaders(normalized)
}

export function observeGhApiIncludeOutput(output: string): string {
  const parsed = parseGhApiIncludeOutput(output)
  applyHeaders(parsed.headers)
  return parsed.body
}

async function ensureBudget(now = Date.now()): Promise<void> {
  if (budget && budget.resetAt > now) {
    return
  }

  if (!bootstrapInProgress) {
    bootstrapInProgress = bootstrapBudget().finally(() => {
      bootstrapInProgress = null
    })
  }
  await bootstrapInProgress

  if (!budget) {
    setFallbackBudget(now)
  }
}

function consumeBudgetSlot(): void {
  const now = Date.now()
  if (!budget) setFallbackBudget(now)
  if (!budget) return

  budget = {
    ...budget,
    remaining: Math.max(0, budget.remaining - 1),
    updatedAt: now,
  }
}

/**
 * Acquire a slot before making a GitHub CLI call.
 *
 * The call waits only when GitHub's real headers say the token is exhausted or
 * asked us to respect `Retry-After`. Otherwise it consumes one in-memory slot
 * and lets GitHub remain the final authority for the request.
 */
export async function acquireGhSlot(): Promise<void> {
  await ensureBudget()

  const now = Date.now()
  if (retryAfterUntil > now) {
    await Bun.sleep(retryAfterUntil - now)
    retryAfterUntil = 0
    await ensureBudget()
  }

  if (budget && budget.remaining <= 0 && budget.resetAt > Date.now()) {
    await Bun.sleep(budget.resetAt - Date.now())
    await ensureBudget()
  }

  consumeBudgetSlot()
}

/** Get current usage stats for diagnostics. */
export async function getGhRateLimitStats(): Promise<{
  used: number
  limit: number
  remaining: number
}> {
  await ensureBudget()
  const current = budget ?? {
    limit: DEFAULT_LIMIT,
    remaining: DEFAULT_LIMIT,
    resetAt: Date.now() + DEFAULT_RESET_WINDOW_MS,
    updatedAt: Date.now(),
  }

  return {
    used: Math.max(0, current.limit - current.remaining),
    limit: current.limit,
    remaining: current.remaining,
  }
}

export function resetGhRateLimitStateForTests(): void {
  budget = null
  retryAfterUntil = 0
  bootstrapInProgress = null
}

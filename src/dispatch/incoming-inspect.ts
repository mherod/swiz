/**
 * Utilities to inspect and query captured dispatch payloads.
 *
 * Usage:
 *   bun src/dispatch/incoming-inspect.ts [filter] [options]
 *   bun src/dispatch/incoming-inspect.ts list-events
 *   bun src/dispatch/incoming-inspect.ts errors
 *   bun src/dispatch/incoming-inspect.ts event preToolUse --limit 5
 */

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { stderrLog } from "../debug.ts"
import { SWIZ_INCOMING_ROOT } from "../temp-paths.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"

interface CaptureEnvelope {
  _swizIncomingCapture: {
    formatVersion?: number
    canonicalEvent: string
    hookEventName: string
    capturedAt: string
    parseError: boolean
    payloadBytes?: number
    payloadSha256?: string
  }
  incoming?: Record<string, any>
  afterNormalizeAndBackfill?: Record<string, any>
  normalizationDelta?: { set: Record<string, any>; removed: string[] }
}

interface CaptureStats {
  total: number
  byCanonicalEvent: Record<string, number>
  byHookEventName: Record<string, number>
  parseErrors: number
  oldestFile: string | null
  oldestTime: number | null
  newestFile: string | null
  newestTime: number | null
}

/** Get all capture files. */
async function listCaptureFiles(
  dir: string = SWIZ_INCOMING_ROOT
): Promise<Array<{ name: string; mtimeMs: number }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const files: Array<{ name: string; mtimeMs: number }> = []

    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".json") || ent.name.endsWith(".raw.json")) continue

      try {
        const fullPath = join(dir, ent.name)
        const s = await stat(fullPath)
        files.push({ name: ent.name, mtimeMs: s.mtimeMs })
      } catch {
        // skip files that disappear during iteration
      }
    }

    return files.sort((a, b) => a.mtimeMs - b.mtimeMs)
  } catch {
    return []
  }
}

/** Load a capture envelope from disk. */
function isCaptureEnvelope(value: unknown): value is CaptureEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const metadata = (value as Record<string, unknown>)._swizIncomingCapture
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false
  const record = metadata as Record<string, unknown>
  return (
    typeof record.canonicalEvent === "string" &&
    typeof record.hookEventName === "string" &&
    typeof record.capturedAt === "string" &&
    typeof record.parseError === "boolean"
  )
}

async function loadCapture(
  filename: string,
  dir: string = SWIZ_INCOMING_ROOT
): Promise<CaptureEnvelope | null> {
  try {
    const path = join(dir, filename)
    const content = await Bun.file(path).text()
    const parsed: unknown = JSON.parse(content)
    return isCaptureEnvelope(parsed) ? parsed : null
  } catch {
    return null
  }
}

function initCaptureStats(
  total: number,
  oldest?: { name: string; mtimeMs: number },
  newest?: { name: string; mtimeMs: number }
): CaptureStats {
  return {
    total,
    byCanonicalEvent: {},
    byHookEventName: {},
    parseErrors: 0,
    oldestFile: oldest ? oldest.name : null,
    oldestTime: oldest ? oldest.mtimeMs : null,
    newestFile: newest ? newest.name : null,
    newestTime: newest ? newest.mtimeMs : null,
  }
}

/** Compute summary statistics about captures. */
async function computeStats(dir: string = SWIZ_INCOMING_ROOT): Promise<CaptureStats> {
  const files = await listCaptureFiles(dir)
  const valid: Array<{ file: { name: string; mtimeMs: number }; capture: CaptureEnvelope }> = []
  for (const file of files) {
    const capture = await loadCapture(file.name, dir)
    if (capture) valid.push({ file, capture })
  }

  const stats = initCaptureStats(valid.length, valid[0]?.file, valid.at(-1)?.file)

  for (const { capture: cap } of valid) {
    const { canonicalEvent, hookEventName, parseError } = cap._swizIncomingCapture
    stats.byCanonicalEvent[canonicalEvent] = (stats.byCanonicalEvent[canonicalEvent] ?? 0) + 1
    stats.byHookEventName[hookEventName] = (stats.byHookEventName[hookEventName] ?? 0) + 1
    if (parseError) stats.parseErrors++
  }

  return stats
}

/** Filter captures by canonical event. */
async function filterByCanonicalEvent(
  event: string,
  dir: string = SWIZ_INCOMING_ROOT
): Promise<Array<{ file: string; capture: CaptureEnvelope }>> {
  const files = await listCaptureFiles(dir)
  const results: Array<{ file: string; capture: CaptureEnvelope }> = []

  for (const file of files) {
    const cap = await loadCapture(file.name, dir)
    if (cap && cap._swizIncomingCapture.canonicalEvent === event) {
      results.push({ file: file.name, capture: cap })
    }
  }

  return results
}

/** Filter captures by hook event name (exact or substring). */
async function filterByHookEventName(
  eventName: string,
  substring = false,
  dir: string = SWIZ_INCOMING_ROOT
): Promise<Array<{ file: string; capture: CaptureEnvelope }>> {
  const files = await listCaptureFiles(dir)
  const results: Array<{ file: string; capture: CaptureEnvelope }> = []

  for (const file of files) {
    const cap = await loadCapture(file.name, dir)
    if (cap) {
      const hookEvent = cap._swizIncomingCapture.hookEventName
      const matches = substring ? hookEvent.includes(eventName) : hookEvent === eventName
      if (matches) {
        results.push({ file: file.name, capture: cap })
      }
    }
  }

  return results
}

/** Get captures with parse errors. */
async function getParseErrors(
  dir: string = SWIZ_INCOMING_ROOT
): Promise<Array<{ file: string; capture: CaptureEnvelope }>> {
  const files = await listCaptureFiles(dir)
  const results: Array<{ file: string; capture: CaptureEnvelope }> = []

  for (const file of files) {
    const cap = await loadCapture(file.name, dir)
    if (cap?._swizIncomingCapture.parseError) {
      results.push({ file: file.name, capture: cap })
    }
  }

  return results
}

// ─── CLI Handlers ───────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
Inspect captured dispatch payloads from /tmp/swiz-incoming/

Commands:
  list-events           Show summary of all captures by event
  errors                Show captures with parse errors
  event <name>          Filter by canonical event (e.g., preToolUse)
  hook-event <name>     Filter by hook event name (e.g., PreToolUse)
  recent <n>            Show the last N captures (default: 10)

Options:
  --limit <n>           Limit results (default: 20)
  --json                Output as JSON (for piping)
`)
}

async function handleListEvents(asJson: boolean): Promise<void> {
  const stats = await computeStats()
  if (asJson) {
    console.log(JSON.stringify(stats, null, 2))
    return
  }
  console.log(`Total captures: ${stats.total}`)
  console.log(`Parse errors: ${stats.parseErrors}`)
  console.log(`\nBy canonical event:`)
  for (const [event, count] of Object.entries(stats.byCanonicalEvent).sort()) {
    console.log(`  ${event}: ${count}`)
  }
  console.log(`\nBy hook event name (agent-specific):`)
  for (const [event, count] of Object.entries(stats.byHookEventName).sort()) {
    console.log(`  ${event}: ${count}`)
  }
  if (stats.oldestFile) {
    console.log(
      `\nDate range: ${new Date(stats.oldestTime!).toISOString()} to ${new Date(stats.newestTime!).toISOString()}`
    )
  }
}

async function handleErrors(limit: number, asJson: boolean): Promise<void> {
  const errors = await getParseErrors()
  if (asJson) {
    console.log(JSON.stringify(errors, null, 2))
    return
  }
  if (errors.length === 0) {
    console.log("No parse errors found.")
    return
  }
  console.log(`Found ${errors.length} parse error(s):`)
  for (const { file, capture } of errors.slice(0, limit)) {
    console.log(`\n${file}`)
    console.log(`  payload bytes: ${capture._swizIncomingCapture.payloadBytes ?? "unknown"}`)
    console.log(`  sha256: ${capture._swizIncomingCapture.payloadSha256 ?? "unknown"}`)
  }
}

async function handleEvent(event: string, limit: number, asJson: boolean): Promise<void> {
  const results = await filterByCanonicalEvent(event)
  if (asJson) {
    console.log(JSON.stringify(results, null, 2))
    return
  }
  if (results.length === 0) {
    console.log(`No captures found for canonical event: ${event}`)
    return
  }
  console.log(`Found ${results.length} capture(s) for event "${event}":`)
  for (const { file, capture } of results.slice(0, limit)) {
    const hooks = Object.keys(capture.incoming ?? {}).length > 0 ? "has incoming" : "no incoming"
    console.log(`  ${file} (${hooks})`)
  }
}

async function handleHookEvent(eventName: string, limit: number, asJson: boolean): Promise<void> {
  const results = await filterByHookEventName(eventName, false)
  if (asJson) {
    console.log(JSON.stringify(results, null, 2))
    return
  }
  if (results.length === 0) {
    console.log(`No captures found for hook event: ${eventName}`)
    return
  }
  console.log(`Found ${results.length} capture(s) for hook event "${eventName}":`)
  for (const { file, capture } of results.slice(0, limit)) {
    const canonical = capture._swizIncomingCapture.canonicalEvent
    console.log(`  ${file} (maps to: ${canonical})`)
  }
}

async function handleRecent(countStr: string | undefined, asJson: boolean): Promise<void> {
  const n = parseInt(countStr ?? "10", 10)
  const files = await listCaptureFiles()
  const recent = files.slice(-n)
  if (asJson) {
    const results = []
    for (const file of recent) {
      const cap = await loadCapture(file.name)
      if (cap) results.push({ file: file.name, capture: cap })
    }
    console.log(JSON.stringify(results, null, 2))
    return
  }
  console.log(`Last ${Math.min(n, files.length)} captures:`)
  for (const file of recent) {
    const cap = await loadCapture(file.name)
    if (cap) {
      const { canonicalEvent, hookEventName } = cap._swizIncomingCapture
      console.log(`  ${file}`)
      console.log(`    canonical: ${canonicalEvent}, hook: ${hookEventName}`)
    }
  }
}

async function runCliCommand(
  command: string,
  args: string[],
  limit: number,
  asJson: boolean
): Promise<void> {
  switch (command) {
    case "list-events":
      await handleListEvents(asJson)
      return
    case "errors":
      await handleErrors(limit, asJson)
      return
    case "event":
      if (args[1]) {
        await handleEvent(args[1], limit, asJson)
        return
      }
      break
    case "hook-event":
      if (args[1]) {
        await handleHookEvent(args[1], limit, asJson)
        return
      }
      break
    case "recent":
      await handleRecent(args[1], asJson)
      return
  }
  stderrLog("incoming-inspect-unknown-cmd", `Unknown command: ${command}`)
  process.exit(1)
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printHelp()
    return
  }

  const command = args[0]
  if (!command) {
    printHelp()
    return
  }

  const limitIdx = args.indexOf("--limit")
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "20", 10) : 20
  const asJson = args.includes("--json")

  try {
    await runCliCommand(command, args, limit, asJson)
  } catch (err) {
    stderrLog("incoming-inspect-fatal", messageFromUnknownError(err))
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}

export {
  computeStats,
  filterByCanonicalEvent,
  filterByHookEventName,
  getParseErrors,
  loadCapture,
  listCaptureFiles,
}

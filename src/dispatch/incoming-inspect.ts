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

interface CaptureEnvelope {
  _swizIncomingCapture: {
    canonicalEvent: string
    hookEventName: string
    capturedAt: string
    parseError: boolean
  }
  incoming?: Record<string, any>
  afterNormalizeAndBackfill?: Record<string, any>
  rawPayload?: string
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
async function listCaptureFiles(): Promise<Array<{ name: string; mtimeMs: number }>> {
  try {
    const entries = await readdir(SWIZ_INCOMING_ROOT, { withFileTypes: true })
    const files: Array<{ name: string; mtimeMs: number }> = []

    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue

      try {
        const fullPath = join(SWIZ_INCOMING_ROOT, ent.name)
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
async function loadCapture(filename: string): Promise<CaptureEnvelope | null> {
  try {
    const path = join(SWIZ_INCOMING_ROOT, filename)
    const content = await Bun.file(path).text()
    return JSON.parse(content) as CaptureEnvelope
  } catch {
    return null
  }
}

/** Compute summary statistics about captures. */
async function computeStats(): Promise<CaptureStats> {
  const files = await listCaptureFiles()
  const oldest = files[0]
  const newest = files[files.length - 1]
  const stats: CaptureStats = {
    total: files.length,
    byCanonicalEvent: {},
    byHookEventName: {},
    parseErrors: 0,
    oldestFile: oldest?.name ?? null,
    oldestTime: oldest?.mtimeMs ?? null,
    newestFile: newest?.name ?? null,
    newestTime: newest?.mtimeMs ?? null,
  }

  for (const file of files) {
    const cap = await loadCapture(file.name)
    if (!cap) continue

    const { canonicalEvent, hookEventName, parseError } = cap._swizIncomingCapture
    stats.byCanonicalEvent[canonicalEvent] = (stats.byCanonicalEvent[canonicalEvent] ?? 0) + 1
    stats.byHookEventName[hookEventName] = (stats.byHookEventName[hookEventName] ?? 0) + 1
    if (parseError) stats.parseErrors++
  }

  return stats
}

/** Filter captures by canonical event. */
async function filterByCanonicalEvent(
  event: string
): Promise<Array<{ file: string; capture: CaptureEnvelope }>> {
  const files = await listCaptureFiles()
  const results: Array<{ file: string; capture: CaptureEnvelope }> = []

  for (const file of files) {
    const cap = await loadCapture(file.name)
    if (cap && cap._swizIncomingCapture.canonicalEvent === event) {
      results.push({ file: file.name, capture: cap })
    }
  }

  return results
}

/** Filter captures by hook event name (exact or substring). */
async function filterByHookEventName(
  eventName: string,
  substring = false
): Promise<Array<{ file: string; capture: CaptureEnvelope }>> {
  const files = await listCaptureFiles()
  const results: Array<{ file: string; capture: CaptureEnvelope }> = []

  for (const file of files) {
    const cap = await loadCapture(file.name)
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
async function getParseErrors(): Promise<Array<{ file: string; capture: CaptureEnvelope }>> {
  const files = await listCaptureFiles()
  const results: Array<{ file: string; capture: CaptureEnvelope }> = []

  for (const file of files) {
    const cap = await loadCapture(file.name)
    if (cap?._swizIncomingCapture.parseError) {
      results.push({ file: file.name, capture: cap })
    }
  }

  return results
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
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
    return
  }

  const command = args[0]
  const limit = args.includes("--limit")
    ? parseInt(args[args.indexOf("--limit") + 1] ?? "20", 10)
    : 20
  const asJson = args.includes("--json")

  try {
    if (command === "list-events") {
      const stats = await computeStats()
      if (asJson) {
        console.log(JSON.stringify(stats, null, 2))
      } else {
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
    } else if (command === "errors") {
      const errors = await getParseErrors()
      if (asJson) {
        console.log(JSON.stringify(errors, null, 2))
      } else if (errors.length === 0) {
        console.log("No parse errors found.")
      } else {
        console.log(`Found ${errors.length} parse error(s):`)
        for (const { file, capture } of errors.slice(0, limit)) {
          console.log(`\n${file}`)
          console.log(
            `  raw payload (first 200 chars): ${(capture.rawPayload ?? "").slice(0, 200)}`
          )
        }
      }
    } else if (command === "event" && args[1]) {
      const event = args[1]
      const results = await filterByCanonicalEvent(event)
      if (asJson) {
        console.log(JSON.stringify(results, null, 2))
      } else if (results.length === 0) {
        console.log(`No captures found for canonical event: ${event}`)
      } else {
        console.log(`Found ${results.length} capture(s) for event "${event}":`)
        for (const { file, capture } of results.slice(0, limit)) {
          const hooks =
            Object.keys(capture.incoming ?? {}).length > 0 ? "has incoming" : "no incoming"
          console.log(`  ${file} (${hooks})`)
        }
      }
    } else if (command === "hook-event" && args[1]) {
      const eventName = args[1]
      const results = await filterByHookEventName(eventName, false)
      if (asJson) {
        console.log(JSON.stringify(results, null, 2))
      } else if (results.length === 0) {
        console.log(`No captures found for hook event: ${eventName}`)
      } else {
        console.log(`Found ${results.length} capture(s) for hook event "${eventName}":`)
        for (const { file, capture } of results.slice(0, limit)) {
          const canonical = capture._swizIncomingCapture.canonicalEvent
          console.log(`  ${file} (maps to: ${canonical})`)
        }
      }
    } else if (command === "recent") {
      const n = parseInt(args[1] ?? "10", 10)
      const files = await listCaptureFiles()
      const recent = files.slice(-n)
      if (asJson) {
        const results = []
        for (const file of recent) {
          const cap = await loadCapture(file.name)
          if (cap) results.push({ file: file.name, capture: cap })
        }
        console.log(JSON.stringify(results, null, 2))
      } else {
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
    } else {
      stderrLog("incoming-inspect-unknown-cmd", `Unknown command: ${command}`)
      process.exit(1)
    }
  } catch (err) {
    stderrLog("incoming-inspect-fatal", err instanceof Error ? err.message : String(err))
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

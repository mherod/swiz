/**
 * Keeps docs/lifecycle-event-coverage.md in sync with the two sources of truth:
 *  1. The upstream Claude event surface (HookEventNameSchema in agent-hook-schemas).
 *  2. Claude's eventMap in src/agents.ts (which events swiz actually maps).
 *
 * If Claude adds a lifecycle event, or swiz maps a previously-reserved one, this
 * test fails until the doc table is updated — preventing silent drift.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { HookEventNameSchema } from "agent-hook-schemas/claude"
import { getAgent } from "./agents.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const DOC_PATH = join(ROOT, "docs", "lifecycle-event-coverage.md")

/** Parse the coverage table into { event -> status }. Rows: | `Event` | Mapped/Reserved | ... | */
function parseCoverageTable(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*`([A-Za-z]+)`\s*\|\s*(Mapped|Reserved)\s*\|/)
    if (m?.[1] && m[2]) out[m[1]] = m[2]
  }
  return out
}

describe("lifecycle event coverage doc", () => {
  const claudeEvents = HookEventNameSchema.options as readonly string[]
  const mappedAgentEvents = new Set(Object.values(getAgent("claude")!.eventMap))

  test("coverage doc exists", () => {
    expect(existsSync(DOC_PATH)).toBe(true)
  })

  const table = existsSync(DOC_PATH) ? parseCoverageTable(readFileSync(DOC_PATH, "utf8")) : {}

  test("every Claude lifecycle event appears in the table", () => {
    const missing = claudeEvents.filter((e) => !(e in table))
    expect(missing, `Events missing from coverage doc: ${missing.join(", ")}`).toEqual([])
  })

  test("table lists no unknown events", () => {
    const unknown = Object.keys(table).filter((e) => !claudeEvents.includes(e))
    expect(unknown, `Coverage doc lists non-Claude events: ${unknown.join(", ")}`).toEqual([])
  })

  test("each event's documented status matches Claude's eventMap", () => {
    const mismatches: string[] = []
    for (const event of claudeEvents) {
      const expected = mappedAgentEvents.has(event) ? "Mapped" : "Reserved"
      if (table[event] !== expected) {
        mismatches.push(`${event}: doc says ${table[event]}, eventMap implies ${expected}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { parseContinueArgs } from "./continue.ts"
import { parseCleanupArgs } from "./doctor.ts"
import { parseTranscriptArgs } from "./transcript.ts"

describe("parseTranscriptArgs", () => {
  test("returns defaults for empty args", () => {
    const result = parseTranscriptArgs([])
    expect(result.sessionQuery).toBeNull()
    expect(result.listOnly).toBe(false)
    expect(result.headCount).toBeUndefined()
    expect(result.tailCount).toBeUndefined()
    expect(result.hours).toBeUndefined()
    expect(result.since).toBeUndefined()
    expect(result.until).toBeUndefined()
    expect(result.autoReply).toBe(false)
    expect(result.includeDebug).toBe(false)
    expect(result.userOnly).toBe(false)
    expect(result.allAgents).toBe(false)
    expect(result.explicitAgents).toHaveLength(0)
  })

  test("parses --session with value", () => {
    const result = parseTranscriptArgs(["--session", "abc123"])
    expect(result.sessionQuery).toBe("abc123")
  })

  test("parses -s shorthand", () => {
    const result = parseTranscriptArgs(["-s", "abc123"])
    expect(result.sessionQuery).toBe("abc123")
  })

  test("ignores --session without value (at end of args)", () => {
    const result = parseTranscriptArgs(["--session"])
    expect(result.sessionQuery).toBeNull()
  })

  test("parses --dir with value", () => {
    const result = parseTranscriptArgs(["--dir", "/tmp/test"])
    expect(result.targetDir).toContain("/tmp/test")
  })

  test("parses -d shorthand", () => {
    const result = parseTranscriptArgs(["-d", "/tmp/test"])
    expect(result.targetDir).toContain("/tmp/test")
  })

  test("ignores --dir without value (at end of args)", () => {
    const result = parseTranscriptArgs(["--dir"])
    // Should use cwd default, not crash
    expect(result.targetDir).toBe(process.cwd())
  })

  test("parses --list flag", () => {
    const result = parseTranscriptArgs(["--list"])
    expect(result.listOnly).toBe(true)
  })

  test("parses -l shorthand", () => {
    const result = parseTranscriptArgs(["-l"])
    expect(result.listOnly).toBe(true)
  })

  test("parses --head with value", () => {
    const result = parseTranscriptArgs(["--head", "5"])
    expect(result.headCount).toBe(5)
  })

  test("parses -H shorthand", () => {
    const result = parseTranscriptArgs(["-H", "10"])
    expect(result.headCount).toBe(10)
  })

  test("ignores --head without value", () => {
    const result = parseTranscriptArgs(["--head"])
    expect(result.headCount).toBeUndefined()
  })

  test("parses --tail with value", () => {
    const result = parseTranscriptArgs(["--tail", "3"])
    expect(result.tailCount).toBe(3)
  })

  test("parses -T shorthand", () => {
    const result = parseTranscriptArgs(["-T", "20"])
    expect(result.tailCount).toBe(20)
  })

  test("ignores --tail without value", () => {
    const result = parseTranscriptArgs(["--tail"])
    expect(result.tailCount).toBeUndefined()
  })

  test("parses --auto-reply flag", () => {
    const result = parseTranscriptArgs(["--auto-reply"])
    expect(result.autoReply).toBe(true)
  })

  test("parses --include-debug flag", () => {
    const result = parseTranscriptArgs(["--include-debug"])
    expect(result.includeDebug).toBe(true)
  })

  test("parses --user-only flag", () => {
    const result = parseTranscriptArgs(["--user-only"])
    expect(result.userOnly).toBe(true)
  })

  test("parses --all flag", () => {
    const result = parseTranscriptArgs(["--all"])
    expect(result.allAgents).toBe(true)
  })

  test("parses explicit transcript agent flags", () => {
    const result = parseTranscriptArgs(["--gemini"])
    expect(result.explicitAgents).toHaveLength(1)
    expect(result.explicitAgents[0]?.id).toBe("gemini")
  })

  test("parses multiple flags together", () => {
    const result = parseTranscriptArgs([
      "-s",
      "sess1",
      "--list",
      "--head",
      "5",
      "--auto-reply",
      "--include-debug",
      "--user-only",
    ])
    expect(result.sessionQuery).toBe("sess1")
    expect(result.listOnly).toBe(true)
    expect(result.headCount).toBe(5)
    expect(result.autoReply).toBe(true)
    expect(result.includeDebug).toBe(true)
    expect(result.userOnly).toBe(true)
  })

  test("does not consume flag as value for previous option", () => {
    // --session followed by another flag — next is truthy but it's a flag
    const result = parseTranscriptArgs(["--session", "--list"])
    // --list is treated as the value for --session (it's truthy and next)
    expect(result.sessionQuery).toBe("--list")
  })

  test("parses --hours with value", () => {
    const result = parseTranscriptArgs(["--hours", "4"])
    expect(result.hours).toBe(4)
  })

  test("parses -h shorthand for hours", () => {
    const result = parseTranscriptArgs(["-h", "12"])
    expect(result.hours).toBe(12)
  })

  test("parses fractional --hours", () => {
    const result = parseTranscriptArgs(["--hours", "0.5"])
    expect(result.hours).toBe(0.5)
  })

  test("ignores --hours without value", () => {
    const result = parseTranscriptArgs(["--hours"])
    expect(result.hours).toBeUndefined()
  })

  test("throws on non-positive --hours", () => {
    expect(() => parseTranscriptArgs(["--hours", "0"])).toThrow("Invalid --hours")
    expect(() => parseTranscriptArgs(["--hours", "-5"])).toThrow("Invalid --hours")
  })

  test("throws on non-numeric --hours", () => {
    expect(() => parseTranscriptArgs(["--hours", "abc"])).toThrow("Invalid --hours")
  })

  test("parses --since with ISO date", () => {
    const result = parseTranscriptArgs(["--since", "2026-03-12"])
    expect(result.since).toBe(new Date("2026-03-12").getTime())
  })

  test("parses -S shorthand for since", () => {
    const result = parseTranscriptArgs(["-S", "2026-03-12T14:00:00"])
    expect(result.since).toBe(new Date("2026-03-12T14:00:00").getTime())
  })

  test("parses --until with ISO date", () => {
    const result = parseTranscriptArgs(["--until", "2026-03-13"])
    expect(result.until).toBe(new Date("2026-03-13").getTime())
  })

  test("parses -U shorthand for until", () => {
    const result = parseTranscriptArgs(["-U", "2026-03-13T18:00:00"])
    expect(result.until).toBe(new Date("2026-03-13T18:00:00").getTime())
  })

  test("ignores --since without value", () => {
    const result = parseTranscriptArgs(["--since"])
    expect(result.since).toBeUndefined()
  })

  test("ignores --until without value", () => {
    const result = parseTranscriptArgs(["--until"])
    expect(result.until).toBeUndefined()
  })

  test("throws on invalid --since date string", () => {
    expect(() => parseTranscriptArgs(["--since", "not-a-date"])).toThrow("Invalid --since")
  })

  test("throws on invalid --until date string", () => {
    expect(() => parseTranscriptArgs(["--until", "nope"])).toThrow("Invalid --until")
  })

  test("throws when --since is after --until", () => {
    expect(() => parseTranscriptArgs(["--since", "2026-03-14", "--until", "2026-03-12"])).toThrow(
      "--since must be before --until"
    )
  })

  test("accepts --since equal to --until", () => {
    const result = parseTranscriptArgs(["--since", "2026-03-12", "--until", "2026-03-12"])
    expect(result.since).toBe(result.until)
  })

  test("parses --since and --until together", () => {
    const result = parseTranscriptArgs(["--since", "2026-03-10", "--until", "2026-03-12"])
    expect(result.since).toBe(new Date("2026-03-10").getTime())
    expect(result.until).toBe(new Date("2026-03-12").getTime())
  })

  test("handles unknown flags gracefully", () => {
    const result = parseTranscriptArgs(["--unknown", "value", "--list"])
    expect(result.listOnly).toBe(true)
  })
})

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

describe("parseCleanupArgs", () => {
  test("returns defaults for empty args", () => {
    const result = parseCleanupArgs([])
    expect(result.olderThanMs).toBe(30 * DAY_MS)
    expect(result.olderThanLabel).toBe("30 days")
    expect(result.taskOlderThanMs).toBeNull()
    expect(result.taskOlderThanLabel).toBeNull()
    expect(result.dryRun).toBe(false)
    expect(result.projectFilter).toBeUndefined()
  })

  test("parses --dry-run flag", () => {
    const result = parseCleanupArgs(["--dry-run"])
    expect(result.dryRun).toBe(true)
  })

  test("parses --older-than with bare days", () => {
    const result = parseCleanupArgs(["--older-than", "7"])
    expect(result.olderThanMs).toBe(7 * DAY_MS)
    expect(result.olderThanLabel).toBe("7 days")
  })

  test("parses --older-than with d suffix", () => {
    const result = parseCleanupArgs(["--older-than", "7d"])
    expect(result.olderThanMs).toBe(7 * DAY_MS)
    expect(result.olderThanLabel).toBe("7 days")
  })

  test("parses --older-than with h suffix (hours)", () => {
    const result = parseCleanupArgs(["--older-than", "48h"])
    expect(result.olderThanMs).toBe(48 * HOUR_MS)
    expect(result.olderThanLabel).toBe("48 hours")
  })

  test("uses singular label for 1 day", () => {
    const result = parseCleanupArgs(["--older-than", "1"])
    expect(result.olderThanLabel).toBe("1 day")
  })

  test("uses singular label for 1 hour", () => {
    const result = parseCleanupArgs(["--older-than", "1h"])
    expect(result.olderThanLabel).toBe("1 hour")
  })

  test("throws on --older-than with zero", () => {
    expect(() => parseCleanupArgs(["--older-than", "0"])).toThrow("--older-than")
  })

  test("throws on --older-than with zero hours", () => {
    expect(() => parseCleanupArgs(["--older-than", "0h"])).toThrow("--older-than")
  })

  test("throws on --older-than with non-numeric value", () => {
    expect(() => parseCleanupArgs(["--older-than", "abc"])).toThrow("--older-than")
  })

  test("ignores --older-than without value", () => {
    const result = parseCleanupArgs(["--older-than"])
    expect(result.olderThanMs).toBe(30 * DAY_MS) // default
  })

  test("parses --project with value", () => {
    const result = parseCleanupArgs(["--project", "my-project"])
    expect(result.projectFilter).toBe("my-project")
  })

  test("parses --task-older-than with days", () => {
    const result = parseCleanupArgs(["--task-older-than", "14d"])
    expect(result.taskOlderThanMs).toBe(14 * DAY_MS)
    expect(result.taskOlderThanLabel).toBe("14 days")
  })

  test("parses --task-older-than with hours", () => {
    const result = parseCleanupArgs(["--task-older-than", "72h"])
    expect(result.taskOlderThanMs).toBe(72 * HOUR_MS)
    expect(result.taskOlderThanLabel).toBe("72 hours")
  })

  test("ignores --project without value", () => {
    const result = parseCleanupArgs(["--project"])
    expect(result.projectFilter).toBeUndefined()
  })

  test("parses all flags together", () => {
    const result = parseCleanupArgs(["--dry-run", "--older-than", "14d", "--project", "foo"])
    expect(result.dryRun).toBe(true)
    expect(result.olderThanMs).toBe(14 * DAY_MS)
    expect(result.projectFilter).toBe("foo")
  })
})

describe("parseContinueArgs", () => {
  test("returns defaults for empty args", () => {
    const result = parseContinueArgs([])
    expect(result.targetDir).toBe(process.cwd())
    expect(result.sessionQuery).toBeNull()
    expect(result.printOnly).toBe(false)
  })

  test("parses --dir with value", () => {
    const result = parseContinueArgs(["--dir", "/tmp/proj"])
    expect(result.targetDir).toContain("/tmp/proj")
  })

  test("parses -d shorthand", () => {
    const result = parseContinueArgs(["-d", "/tmp/proj"])
    expect(result.targetDir).toContain("/tmp/proj")
  })

  test("ignores --dir without value", () => {
    const result = parseContinueArgs(["--dir"])
    expect(result.targetDir).toBe(process.cwd())
  })

  test("parses --session with value", () => {
    const result = parseContinueArgs(["--session", "sess123"])
    expect(result.sessionQuery).toBe("sess123")
  })

  test("parses -s shorthand", () => {
    const result = parseContinueArgs(["-s", "sess123"])
    expect(result.sessionQuery).toBe("sess123")
  })

  test("ignores --session without value", () => {
    const result = parseContinueArgs(["--session"])
    expect(result.sessionQuery).toBeNull()
  })

  test("parses --print flag", () => {
    const result = parseContinueArgs(["--print"])
    expect(result.printOnly).toBe(true)
  })

  test("parses all flags together", () => {
    const result = parseContinueArgs(["-d", "/tmp", "-s", "abc", "--print"])
    expect(result.targetDir).toContain("/tmp")
    expect(result.sessionQuery).toBe("abc")
    expect(result.printOnly).toBe(true)
  })

  test("handles unknown flags gracefully", () => {
    const result = parseContinueArgs(["--unknown", "--print"])
    expect(result.printOnly).toBe(true)
  })

  test("parses --provider flag", () => {
    expect(parseContinueArgs(["--provider", "gemini"]).provider).toBe("gemini")
    expect(parseContinueArgs(["--provider", "openrouter"]).provider).toBe("openrouter")
    expect(parseContinueArgs(["-p", "gemini"]).provider).toBe("gemini")
  })

  test("defaults provider to undefined", () => {
    expect(parseContinueArgs([]).provider).toBeUndefined()
  })

  test("throws on invalid --provider value", () => {
    expect(() => parseContinueArgs(["--provider", "openai"])).toThrow(
      'must be "gemini", "claude", or "openrouter"'
    )
  })

  test("accepts claude as a valid --provider value", () => {
    expect(parseContinueArgs(["--provider", "claude"]).provider).toBe("claude")
  })

  test("throws when --provider is missing a value", () => {
    expect(() => parseContinueArgs(["--provider"])).toThrow("Missing value for --provider")
  })
})

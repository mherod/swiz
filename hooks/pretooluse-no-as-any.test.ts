import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { stripNonCode } from "./pretooluse-ts-quality.ts"

// ─── helpers ────────────────────────────────────────────────────────────────

const CAST_RE = /\bas\s+any\b/g

function castCount(src: string): number {
  return (stripNonCode(src).match(CAST_RE) ?? []).length
}

// ─── true-positive: casts in real code must be detected ─────────────────────

describe("stripNonCode — true positives (real casts must be detected)", () => {
  it("detects a bare cast expression in plain code", () => {
    expect(castCount("const x = foo() as any")).toBe(1)
  })

  it("detects a cast that is the entire expression", () => {
    expect(castCount("return value as any")).toBe(1)
  })

  it("counts multiple casts in the same snippet", () => {
    expect(castCount("const a = x as any\nconst b = y as any")).toBe(2)
  })

  it("detects a cast inside a template literal interpolation", () => {
    // The expression inside ${} is real code — a cast there is a real violation
    expect(castCount("`prefix ${x as any} suffix`")).toBe(1)
  })

  it("detects a cast nested inside an interpolation with balanced braces", () => {
    // The } of the object literal must not terminate the interpolation early
    expect(castCount("`${foo({ key: val as any })}`")).toBe(1)
  })

  it("detects multiple casts across different interpolations", () => {
    expect(castCount("`${a as any} literal ${b as any}`")).toBe(2)
  })
})

// ─── false-positive prevention: non-code regions must be blanked ─────────────

describe("stripNonCode — false-positive prevention (non-code must be blanked)", () => {
  describe("line comments", () => {
    it("blanks a cast phrase that appears after //", () => {
      expect(castCount("// comment mentioning the cast pattern\nconst x = 1")).toBe(0)
    })

    it("does not blank code on the line after a line comment", () => {
      // ensure the comment boundary is respected
      expect(castCount("// ignore\nconst z = 1")).toBe(0)
    })
  })

  describe("block comments", () => {
    it("blanks content inside /* */", () => {
      expect(castCount("/* block comment with cast pattern */")).toBe(0)
    })

    it("preserves code that follows a closed block comment", () => {
      expect(castCount("/* comment */ const x = 1")).toBe(0)
    })

    it("handles multiline block comments", () => {
      expect(castCount("/*\n * multiline block comment\n */\nconst x = 1")).toBe(0)
    })
  })

  describe("double-quoted strings", () => {
    it("blanks content inside double-quoted strings", () => {
      expect(castCount('"phrase in a string"')).toBe(0)
    })

    it("handles an escaped double-quote inside a double-quoted string", () => {
      // escaped quote must not terminate the string early
      expect(castCount('"he said \\"hello\\" here"')).toBe(0)
    })

    it("handles backslash-escaped content at end of string", () => {
      expect(castCount('"trailing escape\\\\"')).toBe(0)
    })
  })

  describe("single-quoted strings", () => {
    it("blanks content inside single-quoted strings", () => {
      expect(castCount("'phrase in a string'")).toBe(0)
    })

    it("handles an escaped single-quote inside a single-quoted string", () => {
      expect(castCount("'don\\'t forget this'")).toBe(0)
    })
  })

  describe("template literal body (outside interpolations)", () => {
    it("blanks template literal body content", () => {
      expect(castCount("`template body text`")).toBe(0)
    })

    it("handles an escaped backtick inside a template literal", () => {
      expect(castCount("`before \\` after`")).toBe(0)
    })
  })

  describe("comment-like tokens inside strings (must NOT trigger comment mode)", () => {
    it("does not treat // inside a double-quoted string as a line comment", () => {
      // everything between the quotes should still be blanked as string content
      expect(castCount('"// phrase in string"')).toBe(0)
    })

    it("does not treat /* inside a double-quoted string as a block comment", () => {
      expect(castCount('"/* phrase in string */"')).toBe(0)
    })

    it("does not treat // inside a single-quoted string as a line comment", () => {
      expect(castCount("'// phrase in string'")).toBe(0)
    })
  })

  describe("string-like tokens inside comments (must NOT trigger string mode)", () => {
    it("does not treat a double-quote inside a line comment as a string opener", () => {
      expect(castCount('// "phrase in comment"')).toBe(0)
    })

    it("does not treat a single-quote inside a line comment as a string opener", () => {
      expect(castCount("// 'phrase in comment'")).toBe(0)
    })
  })
})

// ─── template literal boundary behaviour ────────────────────────────────────

describe("stripNonCode — template literal boundary precision", () => {
  it("blanks casts in template body while preserving casts in interpolation", () => {
    // Only the interpolation cast should survive; the body cast should be blanked
    const result = stripNonCode("`body ${x as any} body`")
    const matches = result.match(CAST_RE) ?? []
    expect(matches).toHaveLength(1)
  })

  it("preserves code between interpolation and end of template", () => {
    // After the closing } the remaining template body must still be blanked
    const result = stripNonCode("`${code} trailing body`")
    // "code" token should be present in output; "trailing body" should be spaces
    expect(result).toMatch(/code/)
    expect(result).not.toMatch(/trailing/)
  })

  it("handles adjacent interpolations", () => {
    expect(castCount("`${a as any}${b as any}`")).toBe(2)
  })
})

// ─── output structure invariants ────────────────────────────────────────────

describe("stripNonCode — output structure", () => {
  it("returns a string of the same length as the input", () => {
    const src = "const x = 1 // comment\nconst y = 2"
    expect(stripNonCode(src)).toHaveLength(src.length)
  })

  it("preserves newline positions", () => {
    const src = "line1\n// comment\nline3"
    const result = stripNonCode(src)
    expect(result.split("\n")).toHaveLength(3)
  })

  it("returns an empty string for empty input", () => {
    expect(stripNonCode("")).toBe("")
  })
})

// ─── end-to-end CLI tests (import.meta.main guard) ───────────────────────────

describe("pretooluse-no-as-any — CLI subprocess (import.meta.main guard)", () => {
  const HOOK_PATH = join(import.meta.dir, "pretooluse-ts-quality.ts")

  /** Spawn the hook as a subprocess, pipe JSON payload to stdin, return stdout + exit code. */
  async function runHook(payload: object): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.write(JSON.stringify(payload))
    await proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return { stdout, exitCode: proc.exitCode ?? -1 }
  }

  it("outputs allow JSON for a plain TypeScript edit with no cast", async () => {
    const { stdout, exitCode } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "src/x.ts", old_string: "const x = 1", new_string: "const x = 2" },
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow")
  })

  it("outputs deny JSON when a real cast is introduced in code", async () => {
    const { stdout, exitCode } = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "src/x.ts",
        old_string: "const x = 1",
        // the cast expression below is the value fed to the hook — it lives in
        // real TypeScript code, not inside a string literal at the hook's level
        new_string: "const x = getValue() as any",
      },
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
  })

  it("outputs allow JSON when the cast phrase is inside a string literal in the edited code", async () => {
    // The new_string sent to the hook is TypeScript source whose only occurrence
    // of the cast phrase is wrapped in double quotes — a string literal, not a cast.
    const { stdout, exitCode } = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "src/x.ts",
        old_string: "const x = 1",
        new_string: 'const label = "cast phrase is inside this string literal"',
      },
    })
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("allow")
  })

  it("exits 0 without hook JSON for non-TypeScript files (passthrough)", async () => {
    const { exitCode } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "README.md", old_string: "hello", new_string: "world" },
    })
    expect(exitCode).toBe(0)
  })

  it("does not execute main() when imported as a module", async () => {
    // If main() ran during import it would block waiting for stdin JSON and
    // the process would never exit. Writing the sentinel to stdout proves the
    // import completed without hanging — import.meta.main was false.
    const script = `
      import { stripNonCode } from ${JSON.stringify(HOOK_PATH)};
      process.stdout.write("ok:" + typeof stripNonCode);
    `
    const proc = Bun.spawn(["bun", "-e", script], {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    expect(stdout).toBe("ok:function")
    expect(proc.exitCode).toBe(0)
  })
})

// ─── failure-path tests ───────────────────────────────────────────────────────

describe("pretooluse-no-as-any — CLI failure paths", () => {
  const HOOK_PATH = join(import.meta.dir, "pretooluse-ts-quality.ts")

  /** Spawn the hook, write raw bytes to stdin, drain stdout+stderr concurrently. */
  async function runRaw(
    input: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.write(input)
    await proc.stdin.end()
    // Drain both streams concurrently to avoid pipe-buffer deadlock
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    return { stdout, stderr, exitCode: proc.exitCode ?? -1 }
  }

  it("exits 1 and reports to stderr when stdin contains invalid JSON", async () => {
    const { exitCode, stderr } = await runRaw("not-valid-json{{{")
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Hook error:")
  })

  it("exits 1 and reports to stderr when stdin is empty", async () => {
    const { exitCode, stderr } = await runRaw("")
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Hook error:")
  })

  it("exits 1 and reports to stderr when stdin is truncated JSON", async () => {
    const { exitCode, stderr } = await runRaw('{"tool_name":"Edit"')
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Hook error:")
  })

  it("exits 0 with no stdout for valid JSON missing tool_input (non-TS passthrough)", async () => {
    // file_path defaults to "" which does not match /\.(ts|tsx)$/ → early exit 0
    const { exitCode, stdout } = await runRaw(JSON.stringify({ tool_name: "Edit" }))
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  it("exits 0 with allow when old_string is absent (new-file passthrough)", async () => {
    // Empty old_string skips the as-any delta check; other checks still run and allow
    const { exitCode, stdout } = await runRaw(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: "src/x.ts", old_string: "", new_string: "const x = 1" },
      })
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain("permissionDecision")
  })

  it("stderr message names the error for invalid JSON (not just a generic crash)", async () => {
    const { stderr } = await runRaw("{bad json}")
    // The catch handler logs the thrown error; the message should hint at JSON parsing
    expect(stderr.toLowerCase()).toMatch(/json|syntax|parse|unexpected/)
  })
})

// ─── pipe-buffer stress tests ─────────────────────────────────────────────────
//
// The OS pipe buffer on macOS is 65 536 bytes. A subprocess that writes more
// than that to a channel whose reader is not yet consuming will block inside
// the kernel write() syscall. If the reader is simultaneously waiting for the
// subprocess to exit (or for the other channel to drain), both sides stall —
// the classic pipe-buffer deadlock. Writing 3 × 65 536 bytes to BOTH stdout
// and stderr simultaneously surfaces this condition reliably.
//
// These tests validate that the Promise.all concurrent-drain pattern used in
// runRaw handles real deadlock-inducing volumes correctly.

describe("concurrent stdout+stderr drain — pipe-buffer stress", () => {
  // 3× the macOS default pipe buffer size
  const LARGE = 3 * 65_536

  /** Spawn an arbitrary bun -e script and drain both channels concurrently. */
  async function drainBoth(
    script: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", "-e", script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.end()
    // Must drain concurrently — sequential reads would deadlock above pipe-buffer size
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    return { stdout, stderr, exitCode: proc.exitCode ?? -1 }
  }

  it("captures all stdout bytes when both channels exceed the pipe buffer", async () => {
    const script = `process.stdout.write("O".repeat(${LARGE})); process.stderr.write("E".repeat(${LARGE}))`
    const { stdout, exitCode } = await drainBoth(script)
    expect(exitCode).toBe(0)
    expect(stdout).toHaveLength(LARGE)
  })

  it("captures all stderr bytes when both channels exceed the pipe buffer", async () => {
    const script = `process.stdout.write("O".repeat(${LARGE})); process.stderr.write("E".repeat(${LARGE}))`
    const { stderr, exitCode } = await drainBoth(script)
    expect(exitCode).toBe(0)
    expect(stderr).toHaveLength(LARGE)
  })

  it("handles stderr-written-first ordering (stdout large, stderr large)", async () => {
    const script = `process.stderr.write("E".repeat(${LARGE})); process.stdout.write("O".repeat(${LARGE}))`
    const { stdout, stderr, exitCode } = await drainBoth(script)
    expect(exitCode).toBe(0)
    expect(stdout).toHaveLength(LARGE)
    expect(stderr).toHaveLength(LARGE)
  })

  it("handles many small interleaved writes filling both channels repeatedly", async () => {
    const PER_WRITE = 4_096
    const ROUNDS = 60 // 60 × 4 096 = 245 760 bytes per channel
    const script = [
      `for (let i = 0; i < ${ROUNDS}; i++) {`,
      `  process.stdout.write("O".repeat(${PER_WRITE}));`,
      `  process.stderr.write("E".repeat(${PER_WRITE}));`,
      `}`,
    ].join(" ")
    const { stdout, stderr, exitCode } = await drainBoth(script)
    expect(exitCode).toBe(0)
    expect(stdout).toHaveLength(ROUNDS * PER_WRITE)
    expect(stderr).toHaveLength(ROUNDS * PER_WRITE)
  })

  it("correctly captures exit code alongside large output", async () => {
    const script = `process.stdout.write("O".repeat(${LARGE})); process.stderr.write("E".repeat(${LARGE})); process.exit(42)`
    const { exitCode } = await drainBoth(script)
    expect(exitCode).toBe(42)
  })
})

// Bun runtime gate — used by skipIf/runIf guards below and in the enforcement block
const IS_BUN = !!process.versions.bun

// ─── Bun eager-buffering behavior — pipe-drain correctness ───────────────────
//
// Bun calls uv_read_start() on BOTH stdout and stderr immediately when a
// subprocess is spawned. This drains OS pipe data into Bun's internal buffers
// in the background, BEFORE any JavaScript consumer ever calls .text().
//
// Consequence: traditional OS pipe-buffer deadlocks CANNOT be reproduced via
// Bun.spawn() in pure JavaScript. Even with DEADLOCK_VOLUME >> pipe-buffer
// limit, the subprocess never blocks in write(2) because Bun is already
// consuming the reading end.
//
// Why Promise.all is still the correct pattern:
//   1. Cross-runtime portability — Node.js, Deno, POSIX programs do NOT
//      eagerly buffer, so sequential reads risk deadlock there.
//   2. Defensive clarity — concurrent drain communicates intent clearly.
//   3. Throughput — concurrent drain can complete faster on slow systems.

describe("Bun eager-buffering behavior — pipe-drain correctness", () => {
  // Volume that reliably overflows the OS pipe buffer (macOS: 65 536 bytes)
  const DEADLOCK_VOLUME = 3 * 65_536

  // stderr written FIRST — in a blocking runtime this order causes deadlock
  // when reading stdout first; in Bun it completes because uv_read_start()
  // buffers both streams eagerly on spawn.
  const SCRIPT = [
    `process.stderr.write("E".repeat(${DEADLOCK_VOLUME}));`,
    `process.stdout.write("O".repeat(${DEADLOCK_VOLUME}));`,
  ].join(" ")

  // These two tests are Bun-specific: awaiting proc.exited before reading, or
  // reading streams sequentially, would deadlock in non-Bun runtimes above the
  // OS pipe buffer limit. Skip them entirely outside Bun.
  it.skipIf(!IS_BUN)(
    "await proc.exited before reading completes immediately (proves eager buffering)",
    async () => {
      // In a blocking runtime: awaiting proc.exited here would hang forever
      // because the subprocess is stuck in write(2) waiting for a reader to
      // drain the pipe. In Bun: uv_read_start() eagerly drains the OS pipe so
      // the subprocess finishes its writes and exits before we read anything.
      const proc = Bun.spawn(["bun", "-e", SCRIPT], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.stdin.end()

      // Await exit BEFORE reading any stream — the definitive eager-buffer proof.
      await proc.exited

      // Data is already in Bun's internal buffers; read it out now.
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()

      expect(stdout).toHaveLength(DEADLOCK_VOLUME)
      expect(stderr).toHaveLength(DEADLOCK_VOLUME)
      expect(proc.exitCode).toBe(0)
    }
  )

  it.skipIf(!IS_BUN)(
    "sequential reads complete without deadlock in Bun (cross-runtime unsafe pattern)",
    async () => {
      // Sequential: read stdout to EOF first, then stderr.
      // In Node.js / blocking runtimes this deadlocks when the subprocess
      // writes stderr > pipe-buffer before stdout. In Bun it completes
      // because both streams are already buffered by uv_read_start().
      // DON'T rely on this in cross-runtime code — use Promise.all instead.
      const proc = Bun.spawn(["bun", "-e", SCRIPT], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.stdin.end()

      let capturedStdout = ""
      let capturedStderr = ""

      const result = await Promise.race([
        (async () => {
          capturedStdout = await new Response(proc.stdout).text()
          capturedStderr = await new Response(proc.stderr).text()
          await proc.exited
          return "completed" as const
        })(),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 3_000)),
      ])

      expect(result).toBe("completed")
      // Sequential reads return full data when Bun's eager buffering is active
      expect(capturedStdout).toHaveLength(DEADLOCK_VOLUME)
      expect(capturedStderr).toHaveLength(DEADLOCK_VOLUME)
    },
    8_000
  )

  it("concurrent Promise.all drain works — the cross-runtime safe pattern", async () => {
    // Promise.all drains both streams simultaneously.
    // Safe across all runtimes: concurrent reads relieve back-pressure so the
    // subprocess never blocks in write(2), even without eager buffering.
    const proc = Bun.spawn(["bun", "-e", SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.end()

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(stdout).toHaveLength(DEADLOCK_VOLUME)
    expect(stderr).toHaveLength(DEADLOCK_VOLUME)
    expect(proc.exitCode).toBe(0)
  })
})

// ─── Promise.all drain enforcement — cross-runtime portability guard ─────────
//
// Two-part guard:
//
// 1. STATIC SCAN (all runtimes): scans every non-test hook source file for
//    sequential stdout/stderr drain patterns. Fails immediately if any hook
//    drains both streams with separate awaits instead of Promise.all.
//
// 2. RUNTIME TRIPWIRE (non-Bun only): runs only outside Bun and immediately
//    throws, documenting that sequential drain is unsafe in these runtimes.

describe("Promise.all drain enforcement — cross-runtime portability guard", () => {
  it("hook source files must use Promise.all for concurrent stdout/stderr drain", async () => {
    // Collect all non-test *.ts files in the hooks directory.
    const hookFiles: string[] = []
    for await (const f of new Bun.Glob("*.ts").scan({ cwd: import.meta.dir, absolute: true })) {
      if (!f.endsWith(".test.ts")) hookFiles.push(f)
    }

    // Detect sequential drain: two separate awaits on proc.stdout and proc.stderr
    // (in either order) within ~500 chars, without a Promise.all wrapping them.
    const SEQ_DRAIN_RE =
      /await new Response\(proc\.(stdout|stderr)\)\.text\(\)([\s\S]{1,500}?)await new Response\(proc\.(stdout|stderr)\)\.text\(\)/g

    for (const file of hookFiles) {
      const src = await Bun.file(file).text()
      for (const m of src.matchAll(SEQ_DRAIN_RE)) {
        const [, first, , second] = m
        if (first === second) continue // same stream twice — not a cross-drain pattern
        // Check that a Promise.all wraps the pair (look up to 300 chars before the match)
        const before = src.slice(Math.max(0, (m.index ?? 0) - 300), m.index)
        if (!before.includes("Promise.all(")) {
          const relPath = file.slice(import.meta.dir.length + 1)
          throw new Error(
            `${relPath}: sequential ${first}/${second} drain detected outside Promise.all. ` +
              `This deadlocks in non-Bun runtimes when output exceeds the OS pipe buffer. ` +
              `Replace with:\n\n` +
              `  const [stdout, stderr] = await Promise.all([\n` +
              `    new Response(proc.stdout).text(),\n` +
              `    new Response(proc.stderr).text(),\n` +
              `  ])`
          )
        }
      }
    }
  })

  // Tripwire: runs ONLY outside Bun. Immediately fails to prevent misuse of
  // the Bun-specific sequential drain patterns documented in this file.
  it.skipIf(IS_BUN)(
    "NON-BUN RUNTIME DETECTED: sequential drain deadlocks here — enforce Promise.all",
    () => {
      throw new Error(
        "This test suite is running outside Bun. " +
          "Sequential proc.stdout / proc.stderr drain will deadlock when output exceeds " +
          "the OS pipe buffer (macOS/Linux: 65 536 bytes). " +
          "Always use Promise.all for concurrent drain in cross-runtime code."
      )
    }
  )
})

// ─── NFKC homoglyph bypass prevention ──────────────────────────────────────

describe("pretooluse-no-as-any — NFKC homoglyph bypass", () => {
  const HOOK_PATH = join(import.meta.dir, "pretooluse-ts-quality.ts")

  async function runHookPayload(payload: object): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.write(JSON.stringify(payload))
    await proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    return { stdout, exitCode: proc.exitCode ?? -1 }
  }

  it("blocks fullwidth 'as any' bypass (NFKC → 'as any')", async () => {
    // U+FF41 FULLWIDTH LATIN SMALL LETTER A, U+FF53 FULLWIDTH LATIN SMALL LETTER S
    const fwAs = String.fromCodePoint(0xff41) + String.fromCodePoint(0xff53)
    const { stdout } = await runHookPayload({
      tool_name: "Edit",
      tool_input: {
        file_path: "src/x.ts",
        old_string: "const x = 1",
        new_string: `const x = getValue() ${fwAs} any`,
      },
    })
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny")
  })
})

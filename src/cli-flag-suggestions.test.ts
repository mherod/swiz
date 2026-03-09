import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { collectUnknownOptionWarnings } from "./cli.ts"

const INDEX_PATH = join(process.cwd(), "index.ts")

async function runSwiz(
  args: string[],
  home?: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", INDEX_PATH, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(home ? { HOME: home } : {}) },
  })
  proc.stdin.end()
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

describe("CLI command suggestions", () => {
  test("suggests closest command for a 1-edit typo", async () => {
    const result = await runSwiz(["doctr"])
    expect(result.stderr).toContain("Unknown command: doctr")
    expect(result.stderr).toContain('did you mean: "doctor"')
    expect(result.exitCode).toBe(1)
  })

  test("no suggestion for a completely unrecognised command", async () => {
    const result = await runSwiz(["xyzqwerty"])
    expect(result.stderr).toContain("Unknown command: xyzqwerty")
    expect(result.stderr).not.toContain("did you mean")
    expect(result.exitCode).toBe(1)
  })
})

describe("CLI flag suggestions", () => {
  test("suggests --fix for --fx on doctor", () => {
    const warnings = collectUnknownOptionWarnings(
      "doctor",
      ["--fx"],
      [{ flags: "--fix", description: "" }]
    )
    expect(warnings[0]).toContain("Unknown option: --fx")
    expect(warnings[0]).toContain('did you mean: "--fix"')
  })

  test("suggests --dry-run for --dryrun on install", () => {
    const warnings = collectUnknownOptionWarnings(
      "install",
      ["--dryrun"],
      [{ flags: "--dry-run", description: "" }]
    )
    expect(warnings[0]).toContain("Unknown option: --dryrun")
    expect(warnings[0]).toContain('did you mean: "--dry-run"')
  })

  test("no suggestion for a completely unrecognised flag", () => {
    const warnings = collectUnknownOptionWarnings(
      "doctor",
      ["--completely-unknown"],
      [{ flags: "--fix", description: "" }]
    )
    expect(warnings[0]).toContain("Unknown option: --completely-unknown")
    expect(warnings[0]).not.toContain("did you mean")
  })

  test("no warning for a valid flag", () => {
    const warnings = collectUnknownOptionWarnings(
      "doctor",
      ["--fix"],
      [{ flags: "--fix", description: "" }]
    )
    expect(warnings.length).toBe(0)
  })

  test("no warning for valid short alias -l on session command", () => {
    const warnings = collectUnknownOptionWarnings(
      "session",
      ["-l"],
      [{ flags: "--list, -l", description: "" }]
    )
    expect(warnings.length).toBe(0)
  })

  test("suggests short alias -l for -ll on session command", () => {
    const warnings = collectUnknownOptionWarnings(
      "session",
      ["-ll"],
      [{ flags: "--list, -l", description: "" }]
    )
    expect(warnings[0]).toContain("Unknown option: -ll")
    expect(warnings[0]).toContain('did you mean: "-l"')
  })

  test("no warning for global --help flag on any command", () => {
    const warnings = collectUnknownOptionWarnings(
      "doctor",
      ["--help"],
      [{ flags: "--fix", description: "" }]
    )
    expect(warnings.length).toBe(0)
  })

  test("no warning for global -h flag on any command", () => {
    const warnings = collectUnknownOptionWarnings(
      "doctor",
      ["-h"],
      [{ flags: "--fix", description: "" }]
    )
    expect(warnings.length).toBe(0)
  })

  test("placeholder token <seconds> is not treated as a known flag", () => {
    const warnings = collectUnknownOptionWarnings(
      "ci-wait",
      ["--timout"],
      [{ flags: "--timeout, -t <seconds>", description: "" }]
    )
    expect(warnings[0]).toContain("Unknown option: --timout")
    expect(warnings[0]).toContain('did you mean: "--timeout"')
    expect(warnings[0]).not.toContain("<seconds>")
  })

  test("placeholder token [id] is not treated as a known flag", () => {
    const warnings = collectUnknownOptionWarnings(
      "settings",
      ["--sesion"],
      [{ flags: "--session, -s [id]", description: "" }]
    )
    expect(warnings[0]).toContain("Unknown option: --sesion")
    expect(warnings[0]).toContain('did you mean: "--session"')
    expect(warnings[0]).not.toContain("[id]")
  })

  test("positional-only option entries do not produce flag warnings", () => {
    const warnings = collectUnknownOptionWarnings(
      "dispatch",
      ["PreToolUse"],
      [
        { flags: "<event>", description: "" },
        { flags: "[agentEventName]", description: "" },
        { flags: "replay <event>", description: "" },
      ]
    )
    expect(warnings.length).toBe(0)
  })
})

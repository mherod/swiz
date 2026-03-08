import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const INDEX_PATH = join(process.cwd(), "index.ts")
const CLI_TEST_TIMEOUT_MS = 20_000

async function runSwiz(
  args: string[],
  home?: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", "run", INDEX_PATH, ...args], {
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
  test(
    "suggests --fix for --fx on doctor",
    async () => {
      const result = await runSwiz(["doctor", "--fx"])
      expect(result.stderr).toContain("Unknown option: --fx")
      expect(result.stderr).toContain('did you mean: "--fix"')
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "suggests --dry-run for --dryrun on install",
    async () => {
      const result = await runSwiz(["install", "--dryrun"])
      expect(result.stderr).toContain("Unknown option: --dryrun")
      expect(result.stderr).toContain('did you mean: "--dry-run"')
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "no suggestion for a completely unrecognised flag",
    async () => {
      const result = await runSwiz(["doctor", "--completely-unknown"])
      expect(result.stderr).toContain("Unknown option: --completely-unknown")
      expect(result.stderr).not.toContain("did you mean")
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "no warning for a valid flag",
    async () => {
      const result = await runSwiz(["doctor", "--fix"])
      expect(result.stderr).not.toContain("Unknown option")
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "no warning for valid short alias -s on session command",
    async () => {
      // session --list/-l is a valid short alias — should not warn
      const result = await runSwiz(["session", "-l"])
      expect(result.stderr).not.toContain("Unknown option: -l")
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "suggests short alias -l for -ll on session command",
    async () => {
      const result = await runSwiz(["session", "-ll"])
      expect(result.stderr).toContain("Unknown option: -ll")
      expect(result.stderr).toContain('did you mean: "-l"')
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "no warning for global --help flag on any command",
    async () => {
      // --help is a global flag; cli.ts routes it before the flag-check block
      const result = await runSwiz(["doctor", "--help"])
      expect(result.stderr).not.toContain("Unknown option: --help")
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "no warning for global -h flag on any command",
    async () => {
      const result = await runSwiz(["doctor", "-h"])
      expect(result.stderr).not.toContain("Unknown option: -h")
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "placeholder token <seconds> is not treated as a known flag",
    async () => {
      // ci-wait declares: flags: "--timeout, -t <seconds>"
      // The "<seconds>" placeholder must be filtered — not added to known flags
      // Verification: a typo of --timeout must suggest --timeout, not <seconds>
      const result = await runSwiz(["ci-wait", "--timout"])
      expect(result.stderr).toContain("Unknown option: --timout")
      expect(result.stderr).toContain('did you mean: "--timeout"')
      expect(result.stderr).not.toContain('"<seconds>"')
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "placeholder token [id] is not treated as a known flag",
    async () => {
      // settings declares: flags: "--session, -s [id]"
      // The "[id]" placeholder must be filtered — not added to known flags
      const result = await runSwiz(["settings", "--sesion"])
      expect(result.stderr).toContain("Unknown option: --sesion")
      expect(result.stderr).toContain('did you mean: "--session"')
      expect(result.stderr).not.toContain('"[id]"')
    },
    CLI_TEST_TIMEOUT_MS
  )

  test(
    "positional-only option entries do not produce flag warnings",
    async () => {
      // dispatch has flags: "<event>", "[agentEventName]", "replay <event>"
      // Passing a positional arg (no leading -) must not trigger Unknown option
      const result = await runSwiz(["dispatch", "PreToolUse"])
      expect(result.stderr).not.toContain("Unknown option: PreToolUse")
    },
    CLI_TEST_TIMEOUT_MS
  )
})

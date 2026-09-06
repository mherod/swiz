import { describe, expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { delimiter, dirname, join, resolve } from "node:path"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { neutralAgentEnv, useTempDir } from "../src/utils/test-utils.ts"
import {
  buildFeatureBranchActionSteps,
  findScript,
  isQualityChecksEnabled,
  LINT_SCRIPTS,
  summarizeCheckOutput,
  TYPECHECK_SCRIPTS,
} from "./stop-quality-checks.ts"

const { create } = useTempDir("swiz-stop-quality-cwd-")

describe("stop-quality-checks: project package manager", () => {
  test("uses hook cwd even when the daemon package manager is cached", async () => {
    const root = await realpath(await create())
    const daemonCwd = join(root, "daemon")
    const projectCwd = join(root, "project")
    const binDir = join(root, "bin")
    for (const directory of [daemonCwd, projectCwd, binDir]) {
      await mkdir(directory, { recursive: true })
    }
    await Bun.write(
      join(daemonCwd, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.0.0" })
    )
    await Bun.write(
      join(projectCwd, "package.json"),
      JSON.stringify({
        packageManager: "bun@1.3.14",
        scripts: {
          lint: "bun quality-check.ts lint",
          typecheck: "bun quality-check.ts typecheck",
        },
      })
    )
    await Bun.write(
      join(projectCwd, "quality-check.ts"),
      `const script = process.argv.at(-1)
await Bun.write("ran-" + script + ".json", JSON.stringify({ cwd: process.cwd(), bun: Bun.version }))
if (script === "lint") {
  process.stderr.write("project-check.ts:1:1 intended Bun lint failure\\n")
  process.exitCode = 1
}
`
    )
    await Bun.write(
      join(binDir, "pnpm"),
      "#!/bin/sh\nprintf '%s\\n' 'unexpected daemon package manager' >&2\nexit 1\n"
    )
    const executable = await spawnWithTimeout(["/bin/chmod", "755", join(binDir, "pnpm")], {
      cwd: root,
      timeoutMs: 1_000,
    })
    expect(executable.exitCode).toBe(0)
    const hookPath = resolve(import.meta.dir, "stop-quality-checks.ts")
    const detectionPath = resolve(import.meta.dir, "../src/utils/package-detection.ts")
    const code = `
import { evaluateStopQualityChecks } from ${JSON.stringify(hookPath)}
import { detectPackageManager } from ${JSON.stringify(detectionPath)}
const cachedPm = await detectPackageManager()
const result = await evaluateStopQualityChecks({
  cwd: ${JSON.stringify(projectCwd)},
  session_id: "quality-cwd-test",
  _effectiveSettings: { qualityChecksGate: true, trunkMode: true }
})
process.stdout.write(JSON.stringify({ cachedPm, result }))
`
    const proc = Bun.spawn([process.execPath, "-e", code], {
      cwd: daemonCwd,
      env: neutralAgentEnv({
        HOME: join(root, "home"),
        PATH: [binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        AI_TEST_NO_BACKEND: "1",
        SWIZ_DIRECT: "1",
      }),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    expect({ exitCode: proc.exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    const output = JSON.parse(stdout)
    expect(output.cachedPm).toBe("pnpm")
    expect(output.result.decision).toBe("block")
    expect(output.result.reason).toContain("`bun run lint` failed")
    expect(output.result.reason).toContain("intended Bun lint failure")
    expect(output.result.reason).not.toContain("unexpected daemon package manager")
    expect(output.result.reason).not.toContain("`bun run typecheck` failed")
    for (const script of ["lint", "typecheck"]) {
      const receipt = await Bun.file(join(projectCwd, `ran-${script}.json`)).json()
      expect(receipt.cwd).toBe(projectCwd)
      expect(receipt.bun).toBe(Bun.version)
    }
  }, 15_000)
})

describe("stop-quality-checks: feature branch guidance", () => {
  test("keeps a preserved worktree on its open PR", () => {
    const steps = buildFeatureBranchActionSteps(
      "main",
      true,
      {
        number: 42,
        url: "https://github.com/user/repo/pull/42",
        mergeable: "CONFLICTING",
      },
      true
    )

    expect(steps.join("\n")).toContain("Keep PR #42 open")
    expect(steps.join("\n")).not.toContain("Merge PR")
    expect(steps.join("\n")).not.toContain("git checkout main")
  })
})

describe("stop-quality-checks: findScript", () => {
  describe("lint script discovery", () => {
    test("finds 'lint' when present", () => {
      expect(findScript({ lint: "biome check ." }, LINT_SCRIPTS)).toBe("lint")
    })

    test("finds 'lint:check' when 'lint' is absent", () => {
      expect(findScript({ "lint:check": "biome check ." }, LINT_SCRIPTS)).toBe("lint:check")
    })

    test("finds 'eslint' when higher-priority names are absent", () => {
      expect(findScript({ eslint: "eslint src" }, LINT_SCRIPTS)).toBe("eslint")
    })

    test("finds 'biome:check' as lowest-priority lint fallback", () => {
      expect(findScript({ "biome:check": "biome check ." }, LINT_SCRIPTS)).toBe("biome:check")
    })

    test("returns first match when multiple lint scripts present", () => {
      expect(findScript({ lint: "biome check .", eslint: "eslint src" }, LINT_SCRIPTS)).toBe("lint")
    })

    test("returns null when no lint script present", () => {
      expect(findScript({ build: "tsc -p tsconfig.build.json" }, LINT_SCRIPTS)).toBeNull()
    })

    test("returns null for empty scripts object", () => {
      expect(findScript({}, LINT_SCRIPTS)).toBeNull()
    })

    test("ignores non-string script values", () => {
      expect(findScript({ lint: 42 as unknown as string }, LINT_SCRIPTS)).toBeNull()
    })
  })

  describe("typecheck script discovery", () => {
    test("finds 'typecheck' when present", () => {
      expect(findScript({ typecheck: "tsc --noEmit" }, TYPECHECK_SCRIPTS)).toBe("typecheck")
    })

    test("finds 'type-check' when 'typecheck' is absent", () => {
      expect(findScript({ "type-check": "tsc --noEmit" }, TYPECHECK_SCRIPTS)).toBe("type-check")
    })

    test("finds 'tsc' when higher-priority names are absent", () => {
      expect(findScript({ tsc: "tsc --noEmit" }, TYPECHECK_SCRIPTS)).toBe("tsc")
    })

    test("finds 'check:types' as lowest-priority typecheck fallback", () => {
      expect(findScript({ "check:types": "tsc --noEmit" }, TYPECHECK_SCRIPTS)).toBe("check:types")
    })

    test("returns first match when multiple typecheck scripts present", () => {
      expect(
        findScript({ typecheck: "tsc --noEmit", "type-check": "vue-tsc" }, TYPECHECK_SCRIPTS)
      ).toBe("typecheck")
    })

    test("returns null when no typecheck script present", () => {
      expect(findScript({ lint: "eslint src", build: "tsc" }, TYPECHECK_SCRIPTS)).toBeNull()
    })
  })

  describe("isQualityChecksEnabled", () => {
    test("returns true when qualityChecksGate is true", () => {
      expect(isQualityChecksEnabled({ _effectiveSettings: { qualityChecksGate: true } })).toBe(true)
    })

    test("returns false when qualityChecksGate is false", () => {
      expect(isQualityChecksEnabled({ _effectiveSettings: { qualityChecksGate: false } })).toBe(
        false
      )
    })

    test("returns false when _effectiveSettings is absent", () => {
      expect(isQualityChecksEnabled({})).toBe(false)
    })

    test("returns false when qualityChecksGate is missing from settings", () => {
      expect(isQualityChecksEnabled({ _effectiveSettings: {} })).toBe(false)
    })

    test("returns false when _effectiveSettings is a non-object (string)", () => {
      expect(isQualityChecksEnabled({ _effectiveSettings: "yes" })).toBe(false)
    })

    test("returns false when _effectiveSettings is null", () => {
      expect(isQualityChecksEnabled({ _effectiveSettings: null })).toBe(false)
    })

    test("returns false when qualityChecksGate is null", () => {
      expect(isQualityChecksEnabled({ _effectiveSettings: { qualityChecksGate: null } })).toBe(
        false
      )
    })

    test("returns true when qualityChecksGate is a truthy non-boolean (coerced)", () => {
      // !! coercion: any truthy value enables the gate — this documents the current behavior
      expect(isQualityChecksEnabled({ _effectiveSettings: { qualityChecksGate: 1 } })).toBe(true)
    })
  })

  describe("script name priority ordering", () => {
    test("LINT_SCRIPTS has lint as first priority", () => {
      expect(LINT_SCRIPTS[0]).toBe("lint")
    })

    test("TYPECHECK_SCRIPTS has typecheck as first priority", () => {
      expect(TYPECHECK_SCRIPTS[0]).toBe("typecheck")
    })

    test("both arrays are non-empty", () => {
      expect(LINT_SCRIPTS.length).toBeGreaterThan(0)
      expect(TYPECHECK_SCRIPTS.length).toBeGreaterThan(0)
    })
  })

  describe("summarizeCheckOutput", () => {
    test("trims verbose code frames to diagnostic headers", () => {
      const verbose = [
        "> swiz@ lint /repo",
        "> biome check . && eslint .",
        "Checked 771 files in 508ms. No fixes applied.",
        "Found 3 errors.",
        "src/skill-utils.ts:298:35 lint/suspicious/noExplicitAny",
        "",
        "  ! Unexpected any. Specify a different type.",
        "    297 │ export async function getRecentlyInvokedSkillsForCurrentSession(",
        "  > 298 │   source: string | Record<string, any>,",
        ...Array.from({ length: 60 }, (_, index) => `frame line ${index}`),
      ].join("\n")

      const summary = summarizeCheckOutput(verbose)

      expect(summary).toContain("Checked 771 files")
      expect(summary).toContain("Found 3 errors")
      expect(summary).toContain("src/skill-utils.ts:298:35")
      expect(summary).toContain("Output trimmed")
      expect(summary).not.toContain("frame line 59")
    })
  })
})

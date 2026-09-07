import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { detectLockfile } from "../hooks/stop-lockfile-drift/lockfile-detector.ts"
import { executeDispatch } from "./dispatch/execute.ts"
import { backfillPayloadDefaults } from "./dispatch/payload-backfill.ts"
import { detectPackageManagerDetails } from "./utils/package-detection.ts"
import { spawnWithTimeout } from "./utils/process-utils.ts"
import { neutralAgentEnv, useTempDir } from "./utils/test-utils.ts"

const { create } = useTempDir("swiz-pm-selection-")

test("npm lockfiles outrank local heuristics and ancestor metadata on repeated reads", async () => {
  const root = await create()
  const project = join(root, "project")
  await mkdir(project)
  await Bun.write(join(root, "pnpm-lock.yaml"), "")
  await Bun.write(join(project, "package.json"), "{}")
  await Bun.write(join(project, "package-lock.json"), "{}")
  await Bun.write(join(project, ".npmrc"), "strict-peer-dependencies=false\n")
  for (let i = 0; i < 2; i++) {
    expect((await detectPackageManagerDetails(root))?.packageManager).toBe("pnpm")
    expect((await detectPackageManagerDetails(project))?.packageManager).toBe("npm")
    expect(await detectLockfile(project, ".")).toEqual({
      lockfile: "package-lock.json",
      installCmd: "npm install",
    })
  }
})

test("explicit declarations and inherited workspaces preserve selection provenance", async () => {
  const root = await create()
  const child = join(root, "packages", "app")
  await mkdir(child, { recursive: true })
  await Bun.write(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0" }))
  expect(await detectPackageManagerDetails(child)).toMatchObject({
    packageManager: "pnpm",
    root,
    source: "packageManager",
  })
  await Bun.write(join(child, "package-lock.json"), "{}")
  expect(await detectPackageManagerDetails(child)).toMatchObject({
    packageManager: "npm",
    root: child,
    source: "lockfile",
  })
  await Bun.write(join(child, "package.json"), JSON.stringify({ packageManager: "yarn@4.0.0" }))
  expect((await detectPackageManagerDetails(child))?.packageManager).toBe("yarn")
})

test("CLI backfill survives forwarding without daemon inference", async () => {
  for (const cwd of [undefined, "", "   "]) {
    const payload: Record<string, unknown> = { cwd, session_id: "selection-cli" }
    await backfillPayloadDefaults(payload)
    const callerCwd = payload.cwd
    expect(typeof callerCwd).toBe("string")
    expect(String(callerCwd).trim().length).toBeGreaterThan(0)
    await backfillPayloadDefaults(payload, { daemonContext: true })
    expect(payload.cwd).toBe(callerCwd)
  }
})

test("daemon rejects missing caller cwd before repository access", async () => {
  for (const cwd of [undefined, "", "   "]) {
    let inspected = false
    await expect(
      executeDispatch({
        canonicalEvent: "stop",
        hookEventName: "Stop",
        daemonContext: true,
        payloadStr: JSON.stringify({ cwd, session_id: "selection-test" }),
        repositoryCapabilityProvider: async () => {
          inspected = true
          throw new Error("wrong repository")
        },
      })
    ).rejects.toThrow("caller cwd")
    expect(inspected).toBe(false)
  }
})

test("repeated npm verification preserves dependencies and reports selection", async () => {
  const root = await create()
  const project = join(root, "project")
  const bin = join(root, "bin")
  await mkdir(join(project, "node_modules", ".bin"), { recursive: true })
  await mkdir(bin)
  await Bun.write(join(root, "pnpm-lock.yaml"), "")
  await Bun.write(join(project, "package.json"), JSON.stringify({ scripts: { lint: "fixture" } }))
  await Bun.write(join(project, "package-lock.json"), "{}")
  await Bun.write(join(project, ".npmrc"), "strict-peer-dependencies=false\n")
  const sentinel = join(project, "node_modules", ".bin", "eslint")
  await Bun.write(sentinel, "preserved")
  for (const pm of ["npm", "pnpm"]) {
    await Bun.write(
      join(bin, pm),
      `#!/bin/sh\nprintf '%s\\n' '${pm}' "$PWD" "$*" >> calls\nexit 1\n`
    )
  }
  expect(
    (await spawnWithTimeout(["/bin/chmod", "755", join(bin, "npm"), join(bin, "pnpm")])).exitCode
  ).toBe(0)
  const hook = resolve(import.meta.dir, "../hooks/stop-quality-checks.ts")
  const code = `import { evaluateStopQualityChecks } from ${JSON.stringify(hook)};
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await evaluateStopQualityChecks({
      cwd: ${JSON.stringify(project)}, session_id: "fixture-selection",
      _effectiveSettings: { qualityChecksGate: true, trunkMode: true }
    }));
    process.stdout.write(JSON.stringify(results));`
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: root,
    env: neutralAgentEnv({
      HOME: join(root, "home"),
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      AI_TEST_NO_BACKEND: "1",
    }),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited).toBe(0)
  expect(stderr).toBe("")
  for (const result of JSON.parse(stdout)) {
    expect(result.reason).toContain("Selection: npm;")
    expect(result.reason).toContain("evidence: lockfile")
  }
  const calls = await Bun.file(join(project, "calls")).text()
  expect(calls.split("\n").filter((line) => line === "run lint")).toHaveLength(2)
  expect(calls).not.toContain("pnpm")
  expect(calls).not.toContain("install")
  expect(await Bun.file(sentinel).text()).toBe("preserved")
}, 15_000)

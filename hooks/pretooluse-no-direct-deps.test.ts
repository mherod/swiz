import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "./test-utils.ts"

const HOOK = "hooks/pretooluse-no-direct-deps.ts"
const { create: createTempDir } = useTempDir("swiz-nodeps-")

interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  denied: boolean
  reason: string
}

async function runHook(
  stdinPayload: Record<string, unknown>,
  envOverrides: Record<string, string | undefined> = {}
): Promise<HookResult> {
  const payload = JSON.stringify(stdinPayload)
  const env: Record<string, string | undefined> = { ...process.env, ...envOverrides }

  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  let denied = false
  let reason = ""
  try {
    const json = JSON.parse(stdout)
    const hso = json?.hookSpecificOutput
    if (hso?.permissionDecision === "deny") {
      denied = true
      reason = hso.permissionDecisionReason ?? ""
    }
  } catch {
    // no JSON output
  }

  return { exitCode: proc.exitCode, stdout, stderr, denied, reason }
}

const REALISTIC_PKG = {
  name: "my-app",
  version: "1.0.0",
  description: "A test package",
  scripts: { test: "bun test", build: "tsc" },
  dependencies: { zod: "^4.3.6", lodash: "^4.17.21" },
  devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0" },
  peerDependencies: { react: "^18.0.0" },
  optionalDependencies: { fsevents: "^2.3.0" },
}

// ─── Bypass / exit-early paths ──────────────────────────────────────────────

describe("early exits", () => {
  test("non-package.json file exits cleanly", async () => {
    const r = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "src/index.ts", old_string: "a", new_string: "b" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.denied).toBe(false)
  })

  test("non-edit tool exits cleanly", async () => {
    const r = await runHook({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.denied).toBe(false)
  })

  test("package.json in node_modules exits cleanly", async () => {
    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "node_modules/foo/package.json",
        old_string: "a",
        new_string: "b",
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.denied).toBe(false)
  })

  test("empty old_string and new_string exits cleanly", async () => {
    const r = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "package.json" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.denied).toBe(false)
  })
})

// ─── Write tool (full-file) ─────────────────────────────────────────────────

describe("Write tool", () => {
  test("writing package.json with dependencies is denied", async () => {
    const r = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "package.json",
        content: JSON.stringify({ name: "app", dependencies: { lodash: "^4.0.0" } }),
      },
    })
    expect(r.denied).toBe(true)
    expect(r.reason).toContain("package manager")
  })

  test("writing package.json with devDependencies is denied", async () => {
    const r = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "package.json",
        content: JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }),
      },
    })
    expect(r.denied).toBe(true)
  })

  test("writing package.json with peerDependencies is denied", async () => {
    const r = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "package.json",
        content: JSON.stringify({ peerDependencies: { react: "^18.0.0" } }),
      },
    })
    expect(r.denied).toBe(true)
  })

  test("writing package.json with optionalDependencies is denied", async () => {
    const r = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "package.json",
        content: JSON.stringify({ optionalDependencies: { fsevents: "^2.3.0" } }),
      },
    })
    expect(r.denied).toBe(true)
  })

  test("writing package.json with scripts only is allowed", async () => {
    const r = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "package.json",
        content: JSON.stringify({ name: "app", scripts: { test: "bun test" } }),
      },
    })
    expect(r.denied).toBe(false)
  })

  test("writing package.json with empty dependencies is allowed", async () => {
    const r = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "package.json",
        content: JSON.stringify({ name: "app", dependencies: {} }),
      },
    })
    expect(r.denied).toBe(false)
  })

  test("writing invalid JSON content exits cleanly (fail-open)", async () => {
    const r = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "package.json",
        content: "not json at all",
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.denied).toBe(false)
  })
})

// ─── Edit tool (projected content) ──────────────────────────────────────────

describe("Edit tool — partial dependency edits", () => {
  test("changing a dependency version is denied", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"zod": "^4.3.6"',
        new_string: '"zod": "^4.3.7"',
      },
    })
    expect(r.denied).toBe(true)
    expect(r.reason).toContain("package manager")
  })

  test("changing a devDependency version is denied", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"typescript": "^5.0.0"',
        new_string: '"typescript": "^5.1.0"',
      },
    })
    expect(r.denied).toBe(true)
  })

  test("adding a new dependency is denied", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"zod": "^4.3.6"',
        new_string: '"zod": "^4.3.6",\n    "axios": "^1.0.0"',
      },
    })
    expect(r.denied).toBe(true)
  })

  test("removing a dependency is denied", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"zod": "^4.3.6",\n    "lodash": "^4.17.21"',
        new_string: '"lodash": "^4.17.21"',
      },
    })
    expect(r.denied).toBe(true)
  })

  test("changing optionalDependencies is denied", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"fsevents": "^2.3.0"',
        new_string: '"fsevents": "^2.4.0"',
      },
    })
    expect(r.denied).toBe(true)
  })

  test("changing peerDependencies is denied", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"react": "^18.0.0"',
        new_string: '"react": "^19.0.0"',
      },
    })
    expect(r.denied).toBe(true)
  })
})

describe("Edit tool — non-dependency edits allowed", () => {
  test("changing scripts is allowed", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"test": "bun test"',
        new_string: '"test": "vitest"',
      },
    })
    expect(r.denied).toBe(false)
  })

  test("changing version is allowed", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"version": "1.0.0"',
        new_string: '"version": "1.1.0"',
      },
    })
    expect(r.denied).toBe(false)
  })

  test("changing description is allowed", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"description": "A test package"',
        new_string: '"description": "An updated package"',
      },
    })
    expect(r.denied).toBe(false)
  })

  test("changing name is allowed", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"name": "my-app"',
        new_string: '"name": "my-new-app"',
      },
    })
    expect(r.denied).toBe(false)
  })

  test("adding a new script is allowed", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: '"build": "tsc"',
        new_string: '"build": "tsc",\n    "lint": "biome check ."',
      },
    })
    expect(r.denied).toBe(false)
  })
})

describe("Edit tool — fail-open on bad state", () => {
  test("file does not exist — fail open", async () => {
    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "/tmp/nonexistent-pkg-test-dir/package.json",
        old_string: '"zod": "^4.3.6"',
        new_string: '"zod": "^4.3.7"',
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.denied).toBe(false)
  })

  test("current file is malformed JSON — fail open", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, "{ broken json here")

    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: "broken",
        new_string: "fixed",
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.denied).toBe(false)
  })

  test("projected content becomes malformed JSON — fail open", async () => {
    const dir = await createTempDir()
    const pkgPath = join(dir, "package.json")
    await writeFile(pkgPath, JSON.stringify(REALISTIC_PKG, null, 2))

    // Replace closing brace with garbage to break projected JSON
    const r = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: pkgPath,
        old_string: "}",
        new_string: "not a brace",
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.denied).toBe(false)
  })
})

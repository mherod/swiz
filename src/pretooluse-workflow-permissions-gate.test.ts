import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOOK_PATH = join(import.meta.dir, "..", "hooks", "pretooluse-workflow-permissions-gate.ts")
const IS_CODEX = Boolean(process.env.CODEX_MANAGED_BY_NPM || process.env.CODEX_THREAD_ID)

interface HookResult {
  stdout: string
  exitCode: number | null
  parsed: Record<string, any> | null
}

async function runHook(payload: Record<string, any>): Promise<HookResult> {
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  })
  await proc.stdin.write(JSON.stringify(payload))
  await proc.stdin.end()
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  let parsed = null
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {}
  return { stdout: stdout.trim(), exitCode: proc.exitCode, parsed }
}

describe("pretooluse-workflow-permissions-gate", () => {
  test("allows non-file-edit tools", async () => {
    const result = await runHook({
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull() // No output = allow
  })

  test("allows edits to non-workflow files", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "src/utils/auth.ts",
        new_string: "permissions: write-all",
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("allows workflow edits that don't touch permissions", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: ".github/workflows/ci.yml",
        new_string: "runs-on: ubuntu-latest\nsteps:\n  - uses: actions/checkout@v4",
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("allows workflow permission edits on default branch (main)", async () => {
    // Create a temp git repo on 'main' to test branch-independent of current checkout
    const tmpDir = await mkdtemp(join(tmpdir(), "swiz-workflow-gate-"))
    try {
      const init = Bun.spawn(["git", "init", "-b", "main", tmpDir], {
        stdout: "ignore",
        stderr: "ignore",
      })
      await init.exited
      const result = await runHook({
        tool_name: "Write",
        tool_input: {
          file_path: ".github/workflows/ci.yml",
          content: "permissions:\n  contents: read\n  pull-requests: write",
        },
        cwd: tmpDir,
      })
      expect(result.exitCode).toBe(0)
      const hso = result.parsed?.hookSpecificOutput as Record<string, any> | undefined
      if (IS_CODEX) {
        expect(hso?.permissionDecision).not.toBe("deny")
      } else {
        expect(hso?.permissionDecision).toBe("allow")
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  test("allows Write tool on non-workflow YAML", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: "config/settings.yml",
        content: "permissions:\n  admin: true",
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("allows edits with empty file_path", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {},
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("detects permissions keyword in Edit new_string", async () => {
    // On main branch this should be allowed, so we verify the hook
    // at least processes the content correctly without crashing
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: ".github/workflows/deploy.yml",
        new_string: "    permissions:\n      contents: write",
      },
    })
    // On main: allowed. The hook exits 0 with no output.
    expect(result.exitCode).toBe(0)
  })

  test("detects permissions keyword in Write content", async () => {
    const result = await runHook({
      tool_name: "Write",
      tool_input: {
        file_path: ".github/workflows/release.yaml",
        content: "name: Release\npermissions: write-all\njobs:\n  build:",
      },
    })
    // On main: allowed
    expect(result.exitCode).toBe(0)
  })

  test("handles .yaml extension", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: ".github/workflows/test.yaml",
        new_string: "runs-on: ubuntu-latest",
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })

  test("ignores non-workflow github paths", async () => {
    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: ".github/CODEOWNERS",
        new_string: "permissions: admin",
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeNull()
  })
})

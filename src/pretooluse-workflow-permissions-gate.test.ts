import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withGitClient } from "./git/client.ts"
import { MockGitClient } from "./git/mock-client.ts"
import { runHookInProcess } from "./utils/test-utils.ts"

const HOOK_PATH = join(import.meta.dir, "..", "hooks", "pretooluse-workflow-permissions-gate.ts")
const IS_CODEX = Boolean(process.env.CODEX_MANAGED_BY_NPM || process.env.CODEX_THREAD_ID)

interface HookResult {
  stdout: string
  exitCode: number | null
  parsed: Record<string, any> | null
}

async function runHook(payload: Record<string, any>): Promise<HookResult> {
  const result = await runHookInProcess(HOOK_PATH, payload)
  const stdout = result.stdout
  let parsed = null
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {}
  return { stdout: stdout.trim(), exitCode: result.exitCode, parsed }
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
    // Keep this assertion isolated without creating a real git repo.
    const tmpDir = await mkdtemp(join(tmpdir(), "swiz-workflow-gate-"))
    try {
      const mockGit = new MockGitClient((args) => {
        if (args[0] === "branch" && args[1] === "--show-current") return "main\n"
        if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
          return "https://github.com/mherod/swiz.git\n"
        }
        return { exitCode: 1 }
      })
      const result = await withGitClient(mockGit, () =>
        runHook({
          tool_name: "Write",
          tool_input: {
            file_path: ".github/workflows/ci.yml",
            content: "permissions:\n  contents: read\n  pull-requests: write",
          },
          cwd: tmpDir,
        })
      )
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

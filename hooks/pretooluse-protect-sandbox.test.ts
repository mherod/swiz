import { describe, expect, setDefaultTimeout, test } from "bun:test"

setDefaultTimeout(30_000)

import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
  extractPreToolSurfaceDecision,
  getHookSpecificOutput,
} from "../src/utils/hook-specific-output.ts"
import { neutralAgentEnv, runFileEditHook } from "../src/utils/test-utils.ts"
import { isSandboxDisableCommand, isTrunkModeDisableCommand } from "./pretooluse-protect-sandbox.ts"

const HOOK = "hooks/pretooluse-protect-sandbox.ts"
const TEST_HOME = homedir()

async function runPinnedHomeBashHook(
  command: string,
  opts: { cwd?: string } = {}
): Promise<{ decision?: string; stdout: string }> {
  const proc = Bun.spawn(["bun", resolve(process.cwd(), HOOK)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: neutralAgentEnv({ HOME: TEST_HOME, SWIZ_DAEMON_PORT: "19999" }),
  })
  await proc.stdin.write(
    JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
    })
  )
  await proc.stdin.end()

  const out = await new Response(proc.stdout).text()
  await proc.exited

  const stdout = out.trim()
  if (!stdout) return { stdout }

  try {
    const parsed = JSON.parse(stdout) as Record<string, any>
    const surface = extractPreToolSurfaceDecision(parsed)
    if (surface.decision || surface.reason) {
      return { ...surface, stdout }
    }
    const hso = getHookSpecificOutput(parsed)
    return hso?.hookEventName === "PreToolUse" ? { decision: "allow", stdout } : { stdout }
  } catch {
    return { stdout }
  }
}

describe("isSandboxDisableCommand", () => {
  test("matches swiz settings disable sandboxed-edits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed-edits")).toBe(true)
  })

  test("matches swiz settings disable sandboxededits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxededits")).toBe(true)
  })

  test("matches swiz settings set sandboxedEdits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxedEdits false")).toBe(true)
  })

  test("does not match unrelated settings commands", () => {
    expect(isSandboxDisableCommand("swiz settings enable sandboxed-edits")).toBe(false)
    expect(isSandboxDisableCommand("swiz settings disable autoContinue")).toBe(false)
    expect(isSandboxDisableCommand("echo hello")).toBe(false)
  })
})

describe("isTrunkModeDisableCommand", () => {
  test("matches swiz settings disable trunk-mode", () => {
    expect(isTrunkModeDisableCommand("swiz settings disable trunk-mode")).toBe(true)
  })

  test("matches swiz settings disable trunkmode", () => {
    expect(isTrunkModeDisableCommand("swiz settings disable trunkmode")).toBe(true)
  })

  test("matches swiz settings set trunkMode false", () => {
    expect(isTrunkModeDisableCommand("swiz settings set trunkMode false")).toBe(true)
  })

  test("does not match unrelated settings commands", () => {
    expect(isTrunkModeDisableCommand("swiz settings enable trunk-mode")).toBe(false)
    expect(isTrunkModeDisableCommand("swiz settings disable sandboxed-edits")).toBe(false)
    expect(isTrunkModeDisableCommand("echo hello")).toBe(false)
  })
})

describe("pretooluse-protect-sandbox (shell commands)", () => {
  test("blocks swiz settings disable sandboxed-edits", async () => {
    const result = await runPinnedHomeBashHook("swiz settings disable sandboxed-edits")
    expect(result.decision).toBe("deny")
  })

  test("blocks swiz settings disable trunk-mode", async () => {
    const result = await runPinnedHomeBashHook("swiz settings disable trunk-mode")
    expect(result.decision).toBe("deny")
  })

  test("blocks swiz settings set trunkMode false", async () => {
    const result = await runPinnedHomeBashHook("swiz settings set trunkMode false")
    expect(result.decision).toBe("deny")
  })

  test("allows unrelated shell commands", async () => {
    const result = await runPinnedHomeBashHook("git status")
    expect(result.decision).toBeUndefined()
  })

  test("allows node -e scripts that only inspect homedir()", async () => {
    const result = await runPinnedHomeBashHook(
      `node -e "const {homedir}=require('os'); console.log(homedir())"`
    )
    expect(result.decision).toBeUndefined()
  })

  test("allows shell commands that read hidden home paths with absolute paths", async () => {
    const result = await runPinnedHomeBashHook(`cat ${join(TEST_HOME, ".swiz", "settings.json")}`)
    expect(result.decision).toBe("allow")
  })

  test("allows shell commands that read hidden home paths with relative paths", async () => {
    const result = await runPinnedHomeBashHook("cat .swiz/settings.json", { cwd: TEST_HOME })
    expect(result.decision).toBe("allow")
  })

  test("allows shell commands that read hidden home paths with $HOME variable", async () => {
    const result = await runPinnedHomeBashHook("cat $HOME/.swiz/settings.json")
    expect(result.decision).toBe("allow")
  })

  test("allows shell commands that read hidden home paths with tilde", async () => {
    const result = await runPinnedHomeBashHook("cat ~/.swiz/settings.json")
    expect(result.decision).toBe("allow")
  })

  test("blocks read-only shell commands against task files", async () => {
    const result = await runPinnedHomeBashHook("cat ~/.claude/tasks/session/1.json")
    expect(result.decision).toBe("deny")
    const parsed = JSON.parse(result.stdout) as Record<string, any>
    const reason =
      ((parsed.hookSpecificOutput as Record<string, any>)?.permissionDecisionReason as string) ?? ""
    expect(reason).toContain("Task file access is blocked")
    expect(reason).toContain("native task tools")
  })

  test("blocks read-only shell commands against Codex task files", async () => {
    const result = await runPinnedHomeBashHook(
      `sed -n '1,20p' ${join(TEST_HOME, ".Codex", "tasks", "session", "1.json")}`
    )
    expect(result.decision).toBe("deny")
  })

  test("allows grep and sed read-only pipelines against hidden home paths", async () => {
    const result = await runPinnedHomeBashHook(
      `grep sandboxedEdits ${join(TEST_HOME, ".swiz", "settings.json")} | head -n 5`
    )
    expect(result.decision).toBe("allow")
  })

  test("blocks shell commands that reference hidden home paths with command substitution", async () => {
    const result = await runPinnedHomeBashHook('cat $(printf "%s" "$HOME")/.swiz/settings.json')
    expect(result.decision).toBe("deny")
  })

  test("blocks shell commands that reference hidden home paths with backtick substitution", async () => {
    const result = await runPinnedHomeBashHook('cat `printf "%s" "$HOME"`/.swiz/settings.json')
    expect(result.decision).toBe("deny")
  })

  test("blocks node -e scripts that build hidden home paths", async () => {
    const result = await runPinnedHomeBashHook(
      `node -e "const fs=require('fs'),path=require('path'),os=require('os');const dir=path.join(os.homedir(),'.Codex','tasks');console.log(fs.readdirSync(dir));"`
    )
    expect(result.decision).toBe("deny")
  })

  test("returns /update-memory guidance for shell commands writing the memory directory", async () => {
    const memoryPath = join(TEST_HOME, ".claude", "projects", "my-project", "memory", "MEMORY.md")
    const result = await runPinnedHomeBashHook(`echo hello > ${memoryPath}`)
    expect(result.decision).toBe("deny")
    const parsed = JSON.parse(result.stdout) as Record<string, any>
    const reason =
      ((parsed.hookSpecificOutput as Record<string, any>)?.permissionDecisionReason as string) ?? ""
    expect(reason).toContain("update-memory")
    expect(reason).toContain("read-only shell command")
  })

  // The harness persists oversized tool stdout under the session's tool-results
  // directory; the agent must be able to read it back even via a compound command.
  const toolResultsPath = join(
    TEST_HOME,
    ".claude",
    "projects",
    "-Users-me-Development-swiz",
    "session-abc",
    "tool-results",
    "out.txt"
  )

  test("allows reading a session tool-results file", async () => {
    const result = await runPinnedHomeBashHook(`tail -25 ${toolResultsPath}`)
    expect(result.decision).toBeUndefined()
  })

  test("allows reading a session tool-results file from a compound command", async () => {
    const result = await runPinnedHomeBashHook(`echo hi; git log -1; tail -25 ${toolResultsPath}`)
    expect(result.decision).toBeUndefined()
  })
})

describe("pretooluse-protect-sandbox (skill file reads #607)", () => {
  test("allows cat of a skill file under ~/.claude/skills/ (current skill root)", async () => {
    const result = await runPinnedHomeBashHook(
      `cat ${join(TEST_HOME, ".claude", "skills", "report-skill-issue", "SKILL.md")}`
    )
    expect(result.decision).toBe("allow")
  })

  test("allows cat of a skill file under ~/.cursor/skills/ (alternate skill root)", async () => {
    const result = await runPinnedHomeBashHook(
      `cat ${join(TEST_HOME, ".cursor", "skills", "report-skill-issue", "SKILL.md")}`
    )
    expect(result.decision).toBe("allow")
  })

  test("blocks writes to skill files under ~/.claude/skills/", async () => {
    const result = await runPinnedHomeBashHook(
      `echo "# Modified" > ${join(TEST_HOME, ".claude", "skills", "report-skill-issue", "SKILL.md")}`
    )
    expect(result.decision).toBe("deny")
  })

  test("blocks writes to skill files under alternate skill root ~/.cursor/skills/", async () => {
    const result = await runPinnedHomeBashHook(
      `echo "# Modified" > ${join(TEST_HOME, ".cursor", "skills", "report-skill-issue", "SKILL.md")}`
    )
    expect(result.decision).toBe("deny")
  })

  test("denial message for blocked skill-path write mentions read-only alternatives and skill roots", async () => {
    const result = await runPinnedHomeBashHook(
      `echo "# Modified" > ${join(TEST_HOME, ".claude", "skills", "report-skill-issue", "SKILL.md")}`
    )
    expect(result.decision).toBe("deny")
    const parsed = JSON.parse(result.stdout) as Record<string, any>
    const reason =
      ((parsed.hookSpecificOutput as Record<string, any>)?.permissionDecisionReason as string) ?? ""
    expect(reason).toContain("skill")
    expect(reason).toContain("read-only")
  })
})

describe("pretooluse-protect-sandbox (file edits)", () => {
  test("blocks Edit to .swiz/config.json", async () => {
    const result = await runFileEditHook(HOOK, {
      filePath: "/some/project/.swiz/config.json",
      newString: '{"sandboxedEdits": false}',
    })
    expect(result.decision).toBe("deny")
  })

  test("blocks Write to .swiz/config.json", async () => {
    const result = await runFileEditHook(HOOK, {
      toolName: "Write",
      filePath: "/some/project/.swiz/config.json",
      content: '{"strictNoDirectMain": false}',
    })
    expect(result.decision).toBe("deny")
  })

  test("blocks .swiz/settings.json edits", async () => {
    const result = await runFileEditHook(HOOK, {
      filePath: "/some/project/.swiz/settings.json",
      newString: "{}",
    })
    expect(result.decision).toBe("deny")
  })

  test("blocks edits to task files", async () => {
    const result = await runFileEditHook(HOOK, {
      filePath: "/some/project/.claude/tasks/session/1.json",
      newString: "{}",
    })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("Task file access is blocked")
  })

  test("allows edits to non-swiz files", async () => {
    const result = await runFileEditHook(HOOK, {
      filePath: "/some/project/src/app.ts",
      newString: "export default {}",
    })
    expect(result.decision).toBeUndefined()
  })

  test("allows edits to files that contain .swiz in their name but are not in .swiz/", async () => {
    const result = await runFileEditHook(HOOK, {
      filePath: "/some/project/src/.swiz-backup.json",
    })
    // .swiz-backup.json is not inside a .swiz/ directory — should be allowed
    expect(result.decision).toBeUndefined()
  })
})

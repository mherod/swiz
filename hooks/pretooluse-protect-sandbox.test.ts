import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  neutralAgentEnvOverrides,
  runFileEditHook,
  runHookInProcess,
} from "../src/utils/test-utils.ts"
import { isSandboxDisableCommand, isTrunkModeDisableCommand } from "./pretooluse-protect-sandbox.ts"

const HOOK = "hooks/pretooluse-protect-sandbox.ts"
const BANNED_COMMANDS_HOOK = "hooks/pretooluse-banned-commands.ts"
const TEST_HOME = homedir()

async function runPinnedHomeBashHook(
  command: string,
  opts: { agent?: "codex"; cwd?: string } = {}
): Promise<{ decision?: string; stdout: string }> {
  const result = await runHookInProcess(
    HOOK,
    {
      ...(opts.agent ? { _agent: opts.agent } : {}),
      tool_name: "Bash",
      tool_input: { command },
    },
    {
      cwd: opts.cwd,
      env: neutralAgentEnvOverrides({ HOME: TEST_HOME, SWIZ_DAEMON_PORT: "19999" }),
    }
  )
  return { decision: result.decision, stdout: result.stdout.trim() }
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

  test("allows Codex shell commands to write within ~/.codex", async () => {
    const result = await runPinnedHomeBashHook(
      `bun -e "await Bun.write('${join(TEST_HOME, ".codex", "config.toml")}', '')"`,
      { agent: "codex" }
    )
    expect(result.decision).toBeUndefined()
  })

  test("still blocks non-Codex shell commands that write within ~/.codex", async () => {
    const result = await runPinnedHomeBashHook(
      `bun -e "await Bun.write('${join(TEST_HOME, ".codex", "config.toml")}', '')"`
    )
    expect(result.decision).toBe("deny")
  })

  test("still blocks Codex shell commands that directly access task storage", async () => {
    const result = await runPinnedHomeBashHook("cat ~/.codex/tasks/session/1.json", {
      agent: "codex",
    })
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

describe("pretooluse-protect-sandbox (recoverable Trash moves #775)", () => {
  let fixtureRoot = ""
  let projectCwd = ""
  let outsideTarget = ""

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "swiz-trash-move-"))
    projectCwd = join(fixtureRoot, "project")
    outsideTarget = join(fixtureRoot, "outside-target.txt")
    await mkdir(projectCwd)
    await Bun.write(join(projectCwd, "disposable-file.txt"), "disposable")
    await mkdir(join(projectCwd, "disposable-directory"))
    await Bun.write(outsideTarget, "preserve")
    await symlink(outsideTarget, join(projectCwd, "disposable-link"))
  })

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  test("allows one existing file to move to the canonical Trash root", async () => {
    const result = await runPinnedHomeBashHook("mv disposable-file.txt ~/.Trash/", {
      cwd: projectCwd,
    })
    expect(result.decision).toBeUndefined()
  })

  test("allows one existing directory without deleting its contents", async () => {
    const result = await runPinnedHomeBashHook("mv disposable-directory ~/.Trash/", {
      cwd: projectCwd,
    })
    expect(result.decision).toBeUndefined()
  })

  test("allows a symlink without following its target outside the cwd", async () => {
    const result = await runPinnedHomeBashHook("mv disposable-link ~/.Trash/", {
      cwd: projectCwd,
    })
    expect(result.decision).toBeUndefined()
    expect(await Bun.file(outsideTarget).text()).toBe("preserve")
  })

  test("blocks arbitrary and nested hidden-home destinations", async () => {
    const arbitrary = await runPinnedHomeBashHook("mv disposable-file.txt ~/.config/", {
      cwd: projectCwd,
    })
    const nestedTrash = await runPinnedHomeBashHook("mv disposable-file.txt ~/.Trash/renamed.txt", {
      cwd: projectCwd,
    })
    expect(arbitrary.decision).toBe("deny")
    expect(nestedTrash.decision).toBe("deny")
  })

  test("blocks missing, outside-cwd, multi-source, and chained moves", async () => {
    const missing = await runPinnedHomeBashHook("mv missing.txt ~/.Trash/", { cwd: projectCwd })
    const outside = await runPinnedHomeBashHook("mv ../outside-target.txt ~/.Trash/", {
      cwd: projectCwd,
    })
    const multiple = await runPinnedHomeBashHook(
      "mv disposable-file.txt disposable-link ~/.Trash/",
      { cwd: projectCwd }
    )
    const chained = await runPinnedHomeBashHook("mv disposable-file.txt ~/.Trash/ && echo moved", {
      cwd: projectCwd,
    })
    expect(missing.decision).toBe("deny")
    expect(outside.decision).toBe("deny")
    expect(multiple.decision).toBe("deny")
    expect(chained.decision).toBe("deny")
  })

  test("allows the fallback printed by the destructive-command guard", async () => {
    const denied = await runHookInProcess(BANNED_COMMANDS_HOOK, {
      tool_name: "Bash",
      tool_input: { command: "unlink disposable-link" },
      cwd: projectCwd,
    })
    const fallbackTemplate = (denied.reason ?? "").match(/• (mv <path> ~\/\.Trash\/)/)?.[1]
    expect(fallbackTemplate).toBe("mv <path> ~/.Trash/")

    const fallback = fallbackTemplate?.replace("<path>", "disposable-link") ?? ""
    const result = await runPinnedHomeBashHook(fallback, { cwd: projectCwd })
    expect(result.decision).toBeUndefined()
  })
})

describe("pretooluse-protect-sandbox (skill file reads #607)", () => {
  test("allows cat of a skill file under the shared ~/.agents/skills root", async () => {
    const result = await runPinnedHomeBashHook(
      `cat ${join(TEST_HOME, ".agents", "skills", "report-skill-issue", "SKILL.md")}`
    )
    expect(result.decision).toBe("allow")
  })

  test("allows compound read-only inspection under the shared ~/.agents root", async () => {
    const agentsRoot = join(TEST_HOME, ".agents")
    const result = await runPinnedHomeBashHook(
      `ls -la ${agentsRoot} && rg --files ${agentsRoot} | head -n 40`
    )
    expect(result.decision).toBe("allow")
  })

  test("allows semicolon-delimited read-only inspection under the shared ~/.agents root", async () => {
    const skillRoot = join(TEST_HOME, ".agents", "skills", "verify-requirements")
    const reference = join(skillRoot, "references", "requirements-document-contract.md")
    const result = await runPinnedHomeBashHook(
      `wc -l ${reference}; find ${join(skillRoot, "presets")} -maxdepth 1 -type f -print; sed -n '1,320p' ${reference}`
    )
    expect(result.decision).toBe("allow")
  })

  test("blocks write-capable find actions under the shared ~/.agents root", async () => {
    const skillRoot = join(TEST_HOME, ".agents", "skills", "verify-requirements")
    const result = await runPinnedHomeBashHook(`find ${skillRoot} -type f -delete`)
    expect(result.decision).toBe("deny")
  })

  test("allows awk line-range inspection under the shared ~/.agents/skills root", async () => {
    const skillPath = join(TEST_HOME, ".agents", "skills", "work-on-issue", "SKILL.md")
    const result = await runPinnedHomeBashHook(`awk 'NR>=251 && NR<=450 {print}' ${skillPath}`)
    expect(result.decision).toBe("allow")
  })

  test("blocks awk programs that write under the shared ~/.agents/skills root", async () => {
    const skillPath = join(TEST_HOME, ".agents", "skills", "work-on-issue", "SKILL.md")
    const result = await runPinnedHomeBashHook(`awk '{print > "${skillPath}"}' ${skillPath}`)
    expect(result.decision).toBe("deny")
  })

  test("allows jq to load a program from the shared ~/.agents/skills root", async () => {
    const result = await runPinnedHomeBashHook(
      "gh issue list --json number,title | " +
        "jq -r -f ~/.agents/skills/morning-standup/scripts/select-issues.jq"
    )
    expect(result.decision).toBeUndefined()
  })

  test("allows Bun to execute a script from the shared ~/.agents/skills root", async () => {
    const scriptPath = join(TEST_HOME, ".agents", "skills", "example", "scripts", "run.ts")
    const result = await runPinnedHomeBashHook(`bun ${scriptPath} --dry-run`)
    expect(result.decision).toBeUndefined()
  })

  test("still blocks another hidden-home input alongside an executable skill asset", async () => {
    const jqProgram = join(
      TEST_HOME,
      ".agents",
      "skills",
      "morning-standup",
      "scripts",
      "select-issues.jq"
    )
    const result = await runPinnedHomeBashHook(
      `jq -f ${jqProgram} ${join(TEST_HOME, ".swiz", "settings.json")}`
    )
    expect(result.decision).toBe("deny")
  })

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

  test("blocks writes appended to reads under the shared ~/.agents root", async () => {
    const skillPath = join(TEST_HOME, ".agents", "skills", "report-skill-issue", "SKILL.md")
    const result = await runPinnedHomeBashHook(`cat ${skillPath} && echo modified > ${skillPath}`)
    expect(result.decision).toBe("deny")
  })

  test("blocks tee writes under the shared ~/.agents/skills root", async () => {
    const skillPath = join(TEST_HOME, ".agents", "skills", "report-skill-issue", "SKILL.md")
    const result = await runPinnedHomeBashHook(`printf modified | tee ${skillPath}`)
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

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getHomeDir } from "../src/home.ts"
import { runHookInProcess } from "../src/utils/test-utils.ts"

const TASKS_DIR = `${getHomeDir()}/.claude/tasks`

async function runHook(filePath: string, toolName = "Read") {
  return await runHookInProcess("hooks/pretooluse-block-tasks-dir-read.ts", {
    tool_name: toolName,
    tool_input: { file_path: filePath },
    session_id: "test-session",
  })
}

async function runBashHook(command: string) {
  return await runHookInProcess("hooks/pretooluse-block-tasks-dir-bash.ts", {
    tool_name: "Bash",
    tool_input: { command },
    session_id: "test-session",
  })
}

async function runGlobHook(pattern: string) {
  return await runHookInProcess("hooks/pretooluse-block-tasks-dir-glob.ts", {
    tool_name: "Glob",
    tool_input: { pattern },
    session_id: "test-session",
  })
}

async function runLsHook(path: string) {
  return await runHookInProcess("hooks/pretooluse-block-tasks-dir-glob.ts", {
    tool_name: "Glob",
    tool_input: { path },
    session_id: "test-session",
  })
}

async function runEditHook(toolName: "Edit" | "Write" | "NotebookEdit", filePath: string) {
  const toolInput =
    toolName === "NotebookEdit" ? { notebook_path: filePath } : { file_path: filePath }
  return await runHookInProcess("hooks/pretooluse-block-tasks-dir-edit.ts", {
    tool_name: toolName,
    tool_input: toolInput,
    session_id: "test-session",
  })
}

describe("pretooluse-block-tasks-dir-read", () => {
  test("blocks read of exact tasks directory", async () => {
    const result = await runHook(TASKS_DIR)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskList")
  })

  test("blocks read of file inside tasks directory", async () => {
    const result = await runHook(`${TASKS_DIR}/abc123/task-1.json`)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskGet")
  })

  test("blocks read of Codex task files", async () => {
    const result = await runHook(`${getHomeDir()}/.codex/tasks/abc123/task-1.json`)
    expect(result.decision).toBe("deny")
  })

  test("blocks read via tilde shorthand", async () => {
    const result = await runHook("~/.claude/tasks/abc123/task-1.json")
    expect(result.decision).toBe("deny")
  })

  test("blocks read of session subdirectory inside tasks directory", async () => {
    const result = await runHook(`${TASKS_DIR}/some-session-id`)
    expect(result.decision).toBe("deny")
  })

  test("allows read of unrelated path", async () => {
    const result = await runHook("/Users/matthewherod/Development/swiz/src/manifest.ts")
    expect(result.decision).toBe("allow")
  })

  test("allows read of path that merely contains tasks substring", async () => {
    const result = await runHook("/tmp/my-tasks/data.json")
    expect(result.decision).toBe("allow")
  })

  test("allows path that is a prefix but not the tasks dir", async () => {
    const result = await runHook(`${TASKS_DIR}-backup/file.json`)
    expect(result.decision).toBe("allow")
  })
})

describe("pretooluse-block-tasks-dir-bash", () => {
  test("blocks cat of file inside tasks directory (expanded path)", async () => {
    const result = await runBashHook(`cat ${TASKS_DIR}/abc123/task-1.json`)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskList")
  })

  test("blocks ls of tasks directory (expanded path)", async () => {
    const result = await runBashHook(`ls ${TASKS_DIR}`)
    expect(result.decision).toBe("deny")
  })

  test("blocks access via tilde shorthand", async () => {
    const result = await runBashHook("cat ~/.claude/tasks/session/task.json")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskGet")
  })

  test("blocks access via $HOME variable", async () => {
    const result = await runBashHook("ls $HOME/.claude/tasks/")
    expect(result.decision).toBe("deny")
  })

  test("blocks access via ${HOME} variable", async () => {
    const result = await runBashHook("cat ${HOME}/.claude/tasks/abc/task.json")
    expect(result.decision).toBe("deny")
  })

  test("blocks access to Codex task files", async () => {
    const result = await runBashHook("cat ~/.Codex/tasks/session/task.json")
    expect(result.decision).toBe("deny")
  })

  test("blocks access to quoted task file paths", async () => {
    const result = await runBashHook('cat "$HOME/.claude/tasks/session/task.json"')
    expect(result.decision).toBe("deny")
  })

  test("allows unrelated Bash command", async () => {
    const result = await runBashHook("git status")
    expect(result.decision).toBe("allow")
  })

  test("allows path that merely contains tasks substring", async () => {
    const result = await runBashHook("ls /tmp/my-tasks/data.json")
    expect(result.decision).toBe("allow")
  })

  test("allows path with tasks-dir prefix but not the tasks dir itself", async () => {
    const result = await runBashHook(`ls ${TASKS_DIR}-backup/file.json`)
    expect(result.decision).toBe("allow")
  })
})

describe("pretooluse-block-tasks-dir-glob", () => {
  test("blocks glob pattern targeting the tasks directory (expanded path)", async () => {
    const result = await runGlobHook(`${TASKS_DIR}/**/*.json`)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskList")
  })

  test("blocks glob pattern equal to the tasks directory", async () => {
    const result = await runGlobHook(TASKS_DIR)
    expect(result.decision).toBe("deny")
  })

  test("blocks glob with wildcard immediately after tasks dir", async () => {
    const result = await runGlobHook(`${TASKS_DIR}*`)
    expect(result.decision).toBe("deny")
  })

  test("blocks glob via tilde shorthand", async () => {
    const result = await runGlobHook("~/.claude/tasks/**/*.json")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskGet")
  })

  test("blocks glob via $HOME variable", async () => {
    const result = await runGlobHook("$HOME/.claude/tasks/*.json")
    expect(result.decision).toBe("deny")
  })

  test("blocks glob targeting Codex tasks", async () => {
    const result = await runGlobHook("~/.codex/tasks/**/*.json")
    expect(result.decision).toBe("deny")
  })

  test("blocks LS path targeting the tasks directory", async () => {
    const result = await runLsHook(TASKS_DIR)
    expect(result.decision).toBe("deny")
  })

  test("allows glob targeting an unrelated path", async () => {
    const result = await runGlobHook("/Users/matthewherod/Development/swiz/**/*.ts")
    expect(result.decision).toBe("allow")
  })

  test("allows glob with tasks substring but not the tasks dir", async () => {
    const result = await runGlobHook("/tmp/my-tasks/**/*.json")
    expect(result.decision).toBe("allow")
  })

  test("allows glob with tasks-dir prefix but not the tasks dir itself", async () => {
    const result = await runGlobHook(`${TASKS_DIR}-backup/**`)
    expect(result.decision).toBe("allow")
  })
})

describe("pretooluse-block-tasks-dir-edit", () => {
  test("blocks Edit of exact tasks directory", async () => {
    const result = await runEditHook("Edit", TASKS_DIR)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskCreate")
  })

  test("blocks Edit of file inside tasks directory", async () => {
    const result = await runEditHook("Edit", `${TASKS_DIR}/abc123/task-1.json`)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TaskUpdate")
  })

  test("blocks Write of file inside tasks directory", async () => {
    const result = await runEditHook("Write", `${TASKS_DIR}/some-session/task.json`)
    expect(result.decision).toBe("deny")
  })

  test("blocks Write of file inside Codex tasks directory", async () => {
    const result = await runEditHook("Write", `${getHomeDir()}/.codex/tasks/session/task.json`)
    expect(result.decision).toBe("deny")
  })

  test("blocks NotebookEdit of notebook inside tasks directory", async () => {
    const result = await runEditHook("NotebookEdit", `${TASKS_DIR}/session-id/notebook.ipynb`)
    expect(result.decision).toBe("deny")
  })

  test("allows Edit of unrelated path", async () => {
    const result = await runEditHook("Edit", "/Users/matthewherod/Development/swiz/src/manifest.ts")
    expect(result.decision).toBe("allow")
  })

  test("allows Write of unrelated path", async () => {
    const result = await runEditHook("Write", "/tmp/my-output.json")
    expect(result.decision).toBe("allow")
  })

  test("allows path that is a prefix but not the tasks dir", async () => {
    const result = await runEditHook("Edit", `${TASKS_DIR}-backup/file.json`)
    expect(result.decision).toBe("allow")
  })
})

describe("block-tasks-dir hardening", () => {
  test("Bash guard fails closed on malformed payload referencing a task path", async () => {
    // tool_input as an array fails the shell schema; the raw payload still names
    // a protected path, so the guard must deny rather than allow.
    const result = await runHookInProcess("hooks/pretooluse-block-tasks-dir-bash.ts", {
      tool_name: "Bash",
      tool_input: [`${TASKS_DIR}/1.json`],
      session_id: "test-session",
    })
    expect(result.decision).toBe("deny")
  })

  test("Bash guard still allows a malformed payload with no task path", async () => {
    const result = await runHookInProcess("hooks/pretooluse-block-tasks-dir-bash.ts", {
      tool_name: "Bash",
      tool_input: ["echo hello"],
      session_id: "test-session",
    })
    expect(result.decision ?? "allow").toBe("allow")
  })

  test("Edit guard resolves a symlink into the tasks dir", async () => {
    const base = await mkdtemp(join(tmpdir(), "swiz-hook-guard-"))
    try {
      const realTasks = join(base, ".claude", "tasks")
      await mkdir(realTasks, { recursive: true })
      await writeFile(join(realTasks, "1.json"), "{}")
      const link = join(base, "link")
      await symlink(realTasks, link)
      const result = await runHookInProcess("hooks/pretooluse-block-tasks-dir-edit.ts", {
        tool_name: "Write",
        tool_input: { file_path: join(link, "1.json") },
        session_id: "test-session",
      })
      expect(result.decision).toBe("deny")
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from "bun:test"
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

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

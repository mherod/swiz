import { describe, expect, it } from "vitest"
import { logSlowHook, toolMatchesToken } from "./engine.ts"

describe("toolMatchesToken", () => {
  describe("exact match", () => {
    it("matches identical names", () => {
      expect(toolMatchesToken("TaskCreate", "TaskCreate")).toBe(true)
      expect(toolMatchesToken("Bash", "Bash")).toBe(true)
    })
  })

  describe("shell family", () => {
    it("matches cross-agent shell tools", () => {
      expect(toolMatchesToken("Bash", "Shell")).toBe(true)
      expect(toolMatchesToken("Shell", "run_shell_command")).toBe(true)
    })
  })

  describe("edit family", () => {
    it("matches cross-agent edit tools", () => {
      expect(toolMatchesToken("Edit", "StrReplace")).toBe(true)
      expect(toolMatchesToken("StrReplace", "Edit")).toBe(true)
    })

    it("does not match write tools", () => {
      expect(toolMatchesToken("Edit", "Write")).toBe(false)
    })
  })

  describe("task tools — specific families (issue #97)", () => {
    it("TaskCreate does NOT match TaskUpdate", () => {
      expect(toolMatchesToken("TaskCreate", "TaskUpdate")).toBe(false)
    })

    it("TaskCreate does NOT match TaskList", () => {
      expect(toolMatchesToken("TaskCreate", "TaskList")).toBe(false)
    })

    it("TaskCreate does NOT match TaskGet", () => {
      expect(toolMatchesToken("TaskCreate", "TaskGet")).toBe(false)
    })

    it("TaskUpdate does NOT match TaskCreate", () => {
      expect(toolMatchesToken("TaskUpdate", "TaskCreate")).toBe(false)
    })

    it("TaskUpdate does NOT match TaskList", () => {
      expect(toolMatchesToken("TaskUpdate", "TaskList")).toBe(false)
    })

    it("TaskList does NOT match TaskGet", () => {
      expect(toolMatchesToken("TaskList", "TaskGet")).toBe(false)
    })

    it("TaskGet does NOT match TaskUpdate", () => {
      expect(toolMatchesToken("TaskGet", "TaskUpdate")).toBe(false)
    })

    it("TaskCreate matches cross-agent equivalents", () => {
      expect(toolMatchesToken("TaskCreate", "TodoWrite")).toBe(true)
      expect(toolMatchesToken("TodoWrite", "TaskCreate")).toBe(true)
      expect(toolMatchesToken("TaskCreate", "write_todos")).toBe(true)
      expect(toolMatchesToken("TaskCreate", "update_plan")).toBe(true)
    })

    it("cross-agent create tools do NOT match TaskUpdate", () => {
      expect(toolMatchesToken("TodoWrite", "TaskUpdate")).toBe(false)
      expect(toolMatchesToken("write_todos", "TaskUpdate")).toBe(false)
      expect(toolMatchesToken("update_plan", "TaskUpdate")).toBe(false)
    })
  })

  describe("task tools — broad 'Task' family", () => {
    it("'Task' token matches all task tools", () => {
      expect(toolMatchesToken("TaskCreate", "Task")).toBe(true)
      expect(toolMatchesToken("TaskUpdate", "Task")).toBe(true)
      expect(toolMatchesToken("TaskList", "Task")).toBe(true)
      expect(toolMatchesToken("TaskGet", "Task")).toBe(true)
      expect(toolMatchesToken("TodoWrite", "Task")).toBe(true)
    })

    it("'Task' toolName matches all task tokens", () => {
      expect(toolMatchesToken("Task", "TaskCreate")).toBe(true)
      expect(toolMatchesToken("Task", "TaskUpdate")).toBe(true)
      expect(toolMatchesToken("Task", "TaskList")).toBe(true)
      expect(toolMatchesToken("Task", "TaskGet")).toBe(true)
    })
  })

  describe("no cross-family matches", () => {
    it("task tools do not match shell tools", () => {
      expect(toolMatchesToken("TaskCreate", "Bash")).toBe(false)
      expect(toolMatchesToken("Bash", "TaskUpdate")).toBe(false)
    })

    it("task tools do not match edit tools", () => {
      expect(toolMatchesToken("TaskCreate", "Edit")).toBe(false)
    })

    it("unknown tools only match exact", () => {
      expect(toolMatchesToken("TaskOutput", "TaskUpdate")).toBe(false)
      expect(toolMatchesToken("TaskOutput", "TaskOutput")).toBe(true)
    })
  })
})

describe("logSlowHook", () => {
  it("returns true when duration strictly exceeds threshold", () => {
    expect(logSlowHook("test-hook.ts", 5000, 3000)).toBe(true)
  })

  it("returns false when duration is below threshold", () => {
    expect(logSlowHook("test-hook.ts", 1000, 3000)).toBe(false)
  })

  it("returns false when duration equals threshold (not strictly over)", () => {
    expect(logSlowHook("test-hook.ts", 3000, 3000)).toBe(false)
  })
})

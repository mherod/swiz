import { describe, expect, it } from "bun:test"
import {
  evaluatePosttooluseJbcontextReindex,
  isReindexTriggeringCommand,
} from "./posttooluse-jbcontext-reindex.ts"

describe("hooks/posttooluse-jbcontext-reindex.ts", () => {
  describe("isReindexTriggeringCommand", () => {
    it("matches git commit commands", () => {
      expect(isReindexTriggeringCommand("git commit -m 'feat: test'")).toBe(true)
      expect(isReindexTriggeringCommand("git commit -am 'quick fix'")).toBe(true)
      expect(isReindexTriggeringCommand("git commit --amend --no-edit")).toBe(true)
    })

    it("matches git merge, pull, rebase, and cherry-pick commands", () => {
      expect(isReindexTriggeringCommand("git merge feature/branch")).toBe(true)
      expect(isReindexTriggeringCommand("git pull origin main")).toBe(true)
      expect(isReindexTriggeringCommand("git rebase origin/main")).toBe(true)
      expect(isReindexTriggeringCommand("git cherry-pick 1234567")).toBe(true)
    })

    it("does not match non-mutating or unrelated commands", () => {
      expect(isReindexTriggeringCommand("git status")).toBe(false)
      expect(isReindexTriggeringCommand("git diff HEAD~1")).toBe(false)
      expect(isReindexTriggeringCommand("git log -n 5")).toBe(false)
      expect(isReindexTriggeringCommand("bun test")).toBe(false)
      expect(isReindexTriggeringCommand("")).toBe(false)
    })
  })

  describe("evaluatePosttooluseJbcontextReindex", () => {
    it("returns empty object for non-shell tools", async () => {
      const result = await evaluatePosttooluseJbcontextReindex({
        tool_name: "Edit",
        tool_input: { file_path: "src/index.ts" },
      })
      expect(result).toEqual({})
    })

    it("returns empty object for non-triggering shell commands", async () => {
      const result = await evaluatePosttooluseJbcontextReindex({
        tool_name: "Bash",
        tool_input: { command: "git status" },
      })
      expect(result).toEqual({})
    })

    it("handles reindexing command safely on live repository", async () => {
      const result = await evaluatePosttooluseJbcontextReindex({
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'test commit'" },
        cwd: process.cwd(),
      })
      expect(result).toEqual({})
    })
  })
})

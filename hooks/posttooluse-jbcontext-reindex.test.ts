import { describe, expect, it, mock } from "bun:test"
import { useTempDir } from "../src/utils/test-utils.ts"
import {
  evaluatePosttooluseJbcontextReindex,
  isReindexTriggeringCommand,
} from "./posttooluse-jbcontext-reindex.ts"

const tmp = useTempDir("swiz-jbcontext-reindex-")

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

    it.each([
      "-C /repo",
      "-c core.autocrlf=false",
      "-C /repo -c core.autocrlf=false",
      '-C "/repo with spaces"',
      '-c "user.name=Test User"',
      "--git-dir /repo/.git",
      "--git-dir=/repo/.git",
      "--work-tree /repo",
      "--work-tree=/repo",
      "--namespace review",
      "--namespace=review",
      "--config-env core.editor=EDITOR",
      "--config-env=core.editor=EDITOR",
      "--no-pager",
    ])("matches supported mutations with global options %s", (options) => {
      for (const operation of ["commit", "merge", "rebase", "pull", "cherry-pick"]) {
        expect(isReindexTriggeringCommand(`git ${options} ${operation}`)).toBe(true)
      }
      for (const operation of ["status", "diff", "log"]) {
        expect(isReindexTriggeringCommand(`git ${options} ${operation}`)).toBe(false)
      }
    })

    it.each([";", "&&", "||", "\n"])("matches commands after a %s boundary", (boundary) => {
      expect(isReindexTriggeringCommand(`true ${boundary} git -C /repo pull`)).toBe(true)
    })

    it.each([
      'echo "git pull"',
      "printf '%s' 'git merge topic'",
      'echo "example; git commit -m fix"',
      "printf '%s' 'example && git pull'",
      'echo "example\ngit rebase main"',
      "echo git cherry-pick abc123",
    ])("ignores command text passed as arguments: %s", (command) => {
      expect(isReindexTriggeringCommand(command)).toBe(false)
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
    function indexingDependencies(configured = true) {
      return {
        isJbcontextConfigured: mock(() => Promise.resolve(configured)),
        triggerJbcontextIndex: mock(() => Promise.resolve(true)),
      }
    }

    it.each([
      ["invalid payload", null],
      ["non-shell tool", { tool_name: "Edit", tool_input: { file_path: "src/index.ts" } }],
      ["read-only command", { tool_name: "Bash", tool_input: { command: "git -C . status" } }],
      ["quoted prose", { tool_name: "Bash", tool_input: { command: 'echo "git -C . pull"' } }],
      [
        "heredoc body",
        { tool_name: "Bash", tool_input: { command: "cat <<'EOF'\ngit -C . pull\nEOF" } },
      ],
    ])("skips configuration and indexing for %s", async (_name, input) => {
      const dependencies = indexingDependencies()
      const result = await evaluatePosttooluseJbcontextReindex(input, dependencies)
      expect(result).toEqual({})
      expect(dependencies.isJbcontextConfigured).not.toHaveBeenCalled()
      expect(dependencies.triggerJbcontextIndex).not.toHaveBeenCalled()
    })

    it.each([
      "git -C . pull",
      "git commit -m 'test commit'",
      "cat <<'EOF'\ngit status\nEOF\ngit -C . pull",
    ])("triggers indexing once for a configured project: %s", async (command) => {
      const cwd = await tmp.create()
      const dependencies = indexingDependencies()
      const result = await evaluatePosttooluseJbcontextReindex(
        { tool_name: "Bash", tool_input: { command }, cwd },
        dependencies
      )
      expect(result).toEqual({})
      expect(dependencies.isJbcontextConfigured).toHaveBeenCalledTimes(1)
      expect(dependencies.isJbcontextConfigured).toHaveBeenCalledWith({ projectPath: cwd })
      expect(dependencies.triggerJbcontextIndex).toHaveBeenCalledTimes(1)
      expect(dependencies.triggerJbcontextIndex).toHaveBeenCalledWith({
        projectPath: cwd,
        silent: true,
      })
    })

    it("skips indexing for an unconfigured project", async () => {
      const cwd = await tmp.create()
      const dependencies = indexingDependencies(false)
      const result = await evaluatePosttooluseJbcontextReindex(
        { tool_name: "Bash", tool_input: { command: "git -C . pull" }, cwd },
        dependencies
      )
      expect(result).toEqual({})
      expect(dependencies.isJbcontextConfigured).toHaveBeenCalledWith({ projectPath: cwd })
      expect(dependencies.triggerJbcontextIndex).not.toHaveBeenCalled()
    })
  })
})

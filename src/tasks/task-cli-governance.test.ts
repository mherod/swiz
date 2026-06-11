import { describe, expect, it } from "bun:test"
import {
  extractSwizTasksSubcommand,
  isAllowedSwizTasksSubcommand,
  isBlockedSwizTaskFilesCommand,
  isBlockedSwizTasksCliCommand,
  isBlockedSwizTasksSubcommand,
  isBlockedTaskFilePath,
  isSwizTasksCommand,
} from "./task-cli-governance.ts"

describe("isBlockedTaskFilePath", () => {
  it("blocks plain ~/.claude/tasks path", () => {
    expect(isBlockedTaskFilePath("~/.claude/tasks/1.json")).toBe(true)
  })

  it("blocks $HOME expanded path", () => {
    expect(isBlockedTaskFilePath("/Users/user/.claude/tasks/abc.json")).toBe(true)
  })

  it("blocks path with trailing slash", () => {
    expect(isBlockedTaskFilePath("~/.claude/tasks/")).toBe(true)
  })

  it("blocks path with subdirectory", () => {
    expect(isBlockedTaskFilePath("~/.claude/tasks/session-id/1.json")).toBe(true)
  })

  it("blocks quoted path (double quotes)", () => {
    expect(isBlockedTaskFilePath('"~/.claude/tasks/1.json"')).toBe(true)
  })

  it("blocks quoted path (single quotes)", () => {
    expect(isBlockedTaskFilePath("'~/.claude/tasks/1.json'")).toBe(true)
  })

  it("blocks uppercase variant (case insensitive)", () => {
    expect(isBlockedTaskFilePath("~/.CLAUDE/TASKS/1.json")).toBe(true)
  })

  it("blocks mixed-slash path", () => {
    expect(isBlockedTaskFilePath("~/.claude/tasks\\1.json")).toBe(true)
  })

  it("allows unrelated file paths", () => {
    expect(isBlockedTaskFilePath("~/.claude/settings.json")).toBe(false)
    expect(isBlockedTaskFilePath("/tmp/output.json")).toBe(false)
    expect(isBlockedTaskFilePath("src/tasks/task-cli-governance.ts")).toBe(false)
  })

  it("blocks bare .claude/tasks without leading separator", () => {
    expect(isBlockedTaskFilePath(".claude/tasks/1.json")).toBe(true)
  })
})

describe("isBlockedSwizTaskFilesCommand", () => {
  it("blocks cat on task file", () => {
    expect(isBlockedSwizTaskFilesCommand("cat ~/.claude/tasks/1.json")).toBe(true)
  })

  it("blocks read via redirection", () => {
    expect(isBlockedSwizTaskFilesCommand("< ~/.claude/tasks/1.json jq .")).toBe(true)
  })

  it("blocks command chain with semicolon", () => {
    expect(isBlockedSwizTaskFilesCommand("ls /tmp; cat ~/.claude/tasks/1.json")).toBe(true)
  })

  it("blocks command chain with &&", () => {
    expect(isBlockedSwizTaskFilesCommand("echo ok && cat ~/.claude/tasks/1.json")).toBe(true)
  })

  it("blocks piped command", () => {
    expect(isBlockedSwizTaskFilesCommand("cat ~/.claude/tasks/1.json | jq .status")).toBe(true)
  })

  it("blocks command with repeated whitespace", () => {
    expect(isBlockedSwizTaskFilesCommand("cat   ~/.claude/tasks/1.json")).toBe(true)
  })

  it("blocks quoted path in command", () => {
    expect(isBlockedSwizTaskFilesCommand("jq .status '~/.claude/tasks/1.json'")).toBe(true)
  })

  it("blocks path with subdirectory in command", () => {
    expect(isBlockedSwizTaskFilesCommand("ls ~/.claude/tasks/session-123/")).toBe(true)
  })

  it("blocks subshell access pattern", () => {
    expect(isBlockedSwizTaskFilesCommand("$(cat ~/.claude/tasks/1.json)")).toBe(true)
  })

  it("blocks mixed-case path in command", () => {
    expect(isBlockedSwizTaskFilesCommand("cat ~/.CLAUDE/TASKS/1.json")).toBe(true)
  })

  it("allows unrelated shell commands", () => {
    expect(isBlockedSwizTaskFilesCommand("ls ~/.claude/settings.json")).toBe(false)
    expect(isBlockedSwizTaskFilesCommand("git status")).toBe(false)
    expect(isBlockedSwizTaskFilesCommand("swiz tasks adopt")).toBe(false)
  })
})

describe("isSwizTasksCommand", () => {
  it("detects swiz tasks", () => {
    expect(isSwizTasksCommand("swiz tasks")).toBe(true)
    expect(isSwizTasksCommand("swiz tasks list")).toBe(true)
    expect(isSwizTasksCommand("swiz tasks complete 1")).toBe(true)
  })

  it("rejects non-tasks swiz commands", () => {
    expect(isSwizTasksCommand("swiz push")).toBe(false)
    expect(isSwizTasksCommand("swiz install")).toBe(false)
  })

  it("rejects unrelated commands", () => {
    expect(isSwizTasksCommand("cat ~/.claude/tasks/1.json")).toBe(false)
    expect(isSwizTasksCommand("git status")).toBe(false)
  })
})

describe("extractSwizTasksSubcommand", () => {
  it("extracts subcommand", () => {
    expect(extractSwizTasksSubcommand("swiz tasks list")).toBe("list")
    expect(extractSwizTasksSubcommand("swiz tasks complete 1")).toBe("complete")
    expect(extractSwizTasksSubcommand("swiz tasks adopt")).toBe("adopt")
  })

  it("returns undefined when no subcommand", () => {
    expect(extractSwizTasksSubcommand("swiz tasks")).toBeUndefined()
  })

  it("returns undefined for non-tasks commands", () => {
    expect(extractSwizTasksSubcommand("swiz push")).toBeUndefined()
  })

  it("returns undefined when subcommand starts with flag", () => {
    expect(extractSwizTasksSubcommand("swiz tasks --help")).toBeUndefined()
  })
})

describe("isAllowedSwizTasksSubcommand", () => {
  it("allows adopt", () => {
    expect(isAllowedSwizTasksSubcommand("adopt")).toBe(true)
  })

  it("blocks list and complete", () => {
    expect(isAllowedSwizTasksSubcommand("list")).toBe(false)
    expect(isAllowedSwizTasksSubcommand("complete")).toBe(false)
  })

  it("blocks undefined", () => {
    expect(isAllowedSwizTasksSubcommand(undefined)).toBe(false)
  })
})

describe("isBlockedSwizTasksSubcommand", () => {
  it("blocks list and complete", () => {
    expect(isBlockedSwizTasksSubcommand("list")).toBe(true)
    expect(isBlockedSwizTasksSubcommand("complete")).toBe(true)
  })

  it("does not block adopt", () => {
    expect(isBlockedSwizTasksSubcommand("adopt")).toBe(false)
  })

  it("blocks undefined (no subcommand = no explicit allowed)", () => {
    expect(isBlockedSwizTasksSubcommand(undefined)).toBe(true)
  })
})

describe("isBlockedSwizTasksCliCommand", () => {
  it("blocks swiz tasks list", () => {
    expect(isBlockedSwizTasksCliCommand("swiz tasks list")).toBe(true)
  })

  it("blocks bare swiz tasks", () => {
    expect(isBlockedSwizTasksCliCommand("swiz tasks")).toBe(true)
  })

  it("allows swiz tasks adopt", () => {
    expect(isBlockedSwizTasksCliCommand("swiz tasks adopt")).toBe(false)
  })

  it("allows unrelated commands", () => {
    expect(isBlockedSwizTasksCliCommand("git status")).toBe(false)
    expect(isBlockedSwizTasksCliCommand("swiz push")).toBe(false)
  })
})

describe("task CLI launch-form detection (hardening)", () => {
  it("detects path-qualified swiz", () => {
    expect(isSwizTasksCommand("/usr/local/bin/swiz tasks list")).toBe(true)
    expect(isSwizTasksCommand("./node_modules/.bin/swiz tasks complete 1")).toBe(true)
    expect(isSwizTasksCommand("bunx swiz tasks status 1 completed")).toBe(true)
  })

  it("detects index.ts launcher forms", () => {
    expect(isSwizTasksCommand("bun run index.ts tasks complete 1")).toBe(true)
    expect(isSwizTasksCommand("bun index.ts tasks status 2 completed")).toBe(true)
    expect(isSwizTasksCommand("bun run ./index.ts tasks create x y")).toBe(true)
    expect(isSwizTasksCommand("node /abs/index.ts tasks complete 1")).toBe(true)
  })

  it("does not match a file literally named tasks", () => {
    expect(isSwizTasksCommand("cat index.ts tasks")).toBe(false)
    expect(isSwizTasksCommand("grep tasks index.ts")).toBe(false)
  })

  it("extracts the subcommand from launcher forms", () => {
    expect(extractSwizTasksSubcommand("bun run index.ts tasks complete 1")).toBe("complete")
    expect(extractSwizTasksSubcommand("/usr/local/bin/swiz tasks update 2")).toBe("update")
  })

  it("blocks mutating subcommands through every launcher", () => {
    expect(isBlockedSwizTasksCliCommand("bun run index.ts tasks complete 5")).toBe(true)
    expect(isBlockedSwizTasksCliCommand("/usr/local/bin/swiz tasks update 3")).toBe(true)
    expect(isBlockedSwizTasksCliCommand("echo hi && bun run index.ts tasks complete 5")).toBe(true)
  })

  it("keeps adopt allowed regardless of launcher", () => {
    expect(isBlockedSwizTasksCliCommand("bun run index.ts tasks adopt")).toBe(false)
  })
})

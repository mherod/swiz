import { describe, expect, it } from "bun:test"
import { homedir } from "node:os"
import { inferRepo, relativeFilePath } from "./cross-repo-issue.ts"

const HOME = homedir()

describe("inferRepo", () => {
  it("infers mherod/skills for ~/.claude/skills/ paths", () => {
    expect(inferRepo(`${HOME}/.claude/skills/my-skill/SKILL.md`)).toBe("mherod/skills")
  })

  it("infers mherod/skills for ~/.cursor/skills/ paths", () => {
    expect(inferRepo(`${HOME}/.cursor/skills/cursor-only-skill/SKILL.md`)).toBe("mherod/skills")
  })

  it("infers mherod/.claude for ~/.claude/hooks/ paths", () => {
    expect(inferRepo(`${HOME}/.claude/hooks/my-hook.ts`)).toBe("mherod/.claude")
  })

  it("returns null for unknown paths", () => {
    expect(inferRepo(`${HOME}/.config/some/other/file.json`)).toBeNull()
  })

  it("returns null for paths that are prefixes of known paths but don't match", () => {
    expect(inferRepo(`${HOME}/.cursor/`)).toBeNull()
    expect(inferRepo(`${HOME}/.claude/`)).toBeNull()
  })
})

describe("relativeFilePath", () => {
  it("strips ~/.claude/skills/ prefix", () => {
    expect(relativeFilePath(`${HOME}/.claude/skills/my-skill/SKILL.md`)).toBe("my-skill/SKILL.md")
  })

  it("strips ~/.cursor/skills/ prefix", () => {
    expect(relativeFilePath(`${HOME}/.cursor/skills/cursor-only-skill/SKILL.md`)).toBe(
      "cursor-only-skill/SKILL.md"
    )
  })

  it("strips ~/.claude/hooks/ prefix", () => {
    expect(relativeFilePath(`${HOME}/.claude/hooks/my-hook.ts`)).toBe("my-hook.ts")
  })

  it("returns the path unchanged for unknown paths", () => {
    const unknown = `${HOME}/.config/other/file.json`
    expect(relativeFilePath(unknown)).toBe(unknown)
  })
})

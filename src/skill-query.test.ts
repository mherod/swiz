import { describe, expect, mock, test } from "bun:test"
import { querySkills, renderSkillQuery } from "./skill-query.ts"
import type { SkillInfo } from "./skill-utils.ts"

const commit: SkillInfo = {
  name: "commit",
  description: "Record verified changes",
  source: "local",
  path: "/project/.skills/commit/SKILL.md",
}
const deploy: SkillInfo = {
  name: "deploy",
  description: "Ship changes",
  source: "global",
  path: "/home/.agents/skills/deploy/SKILL.md",
}

function fixtures(skills = [commit, deploy], content = "# Skill\n") {
  return {
    discover: mock(async (_cwd: string) => skills),
    read: mock(async (_path: string) => content),
  }
}

describe("querySkills", () => {
  test("indexes metadata with bounded pages and preserves discovery precedence", async () => {
    const deps = fixtures()
    const first = await querySkills({ limit: 1 }, "/project", deps)
    expect(first).toEqual({
      action: "list",
      skills: [commit],
      total: 2,
      limit: 1,
      offset: 0,
      nextOffset: 1,
    })
    expect(deps.discover).toHaveBeenCalledWith("/project")
    expect(deps.read).not.toHaveBeenCalled()
    expect(renderSkillQuery(first)).toContain("Next page: offset 1.")
    expect(await querySkills({ offset: 1 }, "/project", deps)).toEqual({
      action: "list",
      skills: [deploy],
      total: 2,
      limit: 50,
      offset: 1,
      nextOffset: null,
    })
    expect(await querySkills({ offset: 9 }, "/project", deps)).toMatchObject({
      skills: [],
      nextOffset: null,
    })
  })

  test("defaults to 50 results and reports a continuation offset", async () => {
    const skills = Array.from({ length: 60 }, (_, i) => ({ ...commit, name: `skill-${i}` }))
    const result = await querySkills({}, "/project", fixtures(skills))
    expect(result).toMatchObject({ total: 60, limit: 50, nextOffset: 50 })
    if (result.action !== "list") throw new Error("Expected index")
    expect(result.skills).toHaveLength(50)
  })

  test("filters names and descriptions case-insensitively before pagination", async () => {
    const deps = fixtures()
    expect(await querySkills({ query: "  COMMIT " }, "/project", deps)).toMatchObject({
      skills: [commit],
      total: 1,
    })
    expect(
      await querySkills({ query: "changes", offset: 1, limit: 1 }, "/project", deps)
    ).toMatchObject({ skills: [deploy], total: 2, nextOffset: null })
    expect(renderSkillQuery(await querySkills({ query: "absent" }, "/project", deps))).toBe(
      "No skills found."
    )
    expect(renderSkillQuery(await querySkills({}, "/project", fixtures([])))).toBe(
      "No skills found."
    )
  })

  test("looks up an exact name without reading its content", async () => {
    const deps = fixtures()
    const result = await querySkills({ action: "lookup", name: "commit" }, "/project", deps)
    expect(result).toEqual({ action: "lookup", skill: commit })
    expect(JSON.parse(renderSkillQuery(result))).toEqual(commit)
    expect(deps.read).not.toHaveBeenCalled()
  })

  test("reads verbatim by default, including inline shell setup", async () => {
    const content = "---\ndescription: Commit\nsetup: !`git status`\n---\n# Commit\n!`git diff`\n"
    const deps = fixtures([commit], content)
    const result = await querySkills({ name: "commit" }, "/project", deps)
    expect(result).toEqual({ action: "read", skill: commit, content })
    expect(renderSkillQuery(result)).toBe(content)
    expect(deps.read).toHaveBeenCalledWith(commit.path)
  })

  test("uses CLI argument substitution and optional frontmatter stripping", async () => {
    const deps = fixtures([commit], "---\ndescription: Commit\n---\n$ARGUMENTS / $0 / $1\n")
    expect(
      await querySkills(
        { action: "read", name: "commit", args: ["first", "second"], noFrontMatter: true },
        "/project",
        deps
      )
    ).toMatchObject({ content: "first second / first / second\n" })
  })

  test("replaces positional args without replacement token expansion", async () => {
    const deps = fixtures([commit], "$0 $1 $ARGUMENTS\n")
    expect(
      await querySkills(
        { action: "read", name: "commit", args: ["hello $& world", "hello $' world"] },
        "/project",
        deps
      )
    ).toMatchObject({ content: "hello $& world hello $' world hello $& world hello $' world\n" })
  })

  test.each([
    "missing",
    "comm",
    "../outside",
    "/etc/passwd",
  ])("rejects undiscovered name %s before reading a file", async (name) => {
    const deps = fixtures()
    await expect(querySkills({ name }, "/project", deps)).rejects.toThrow("Skill not found:")
    expect(deps.read).not.toHaveBeenCalled()
  })

  test.each([
    { action: "execute" },
    { action: "lookup" },
    { action: "read" },
    { action: "list", name: "commit" },
    { name: "commit", query: "changes" },
    { name: "commit", limit: 1 },
    { name: "commit", offset: 1 },
    { args: [] },
    { action: "lookup", name: "commit", noFrontMatter: true },
    { name: " " },
    { query: " " },
    { limit: 201 },
    { limit: 0 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: 0.5 },
    { noFrontMatter: "true" },
    { args: [1] },
    { raw: false },
  ])("rejects invalid arguments %j before discovery", async (input) => {
    const deps = fixtures()
    await expect(querySkills(input, "/project", deps)).rejects.toThrow()
    expect(deps.discover).not.toHaveBeenCalled()
  })

  test("propagates discovery and read failures to the MCP boundary", async () => {
    const deps = fixtures()
    deps.discover.mockRejectedValueOnce(new Error("discovery failed"))
    await expect(querySkills({}, "/project", deps)).rejects.toThrow("discovery failed")
    deps.read.mockRejectedValueOnce(new Error("unreadable skill"))
    await expect(querySkills({ name: "commit" }, "/project", deps)).rejects.toThrow(
      "unreadable skill"
    )
  })
})

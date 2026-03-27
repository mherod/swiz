import { describe, expect, it } from "vitest"
import { getAgentSettingsPath, getAgentSettingsSearchPaths } from "./agent-paths.ts"

describe("getAgentSettingsSearchPaths", () => {
  const homeDir = "/test/home"
  const cwd = "/test/project"

  it("returns global path as first entry for all agents", () => {
    const paths = getAgentSettingsSearchPaths("codex", { homeDir, cwd })
    expect(paths[0]).toBe(getAgentSettingsPath("codex", homeDir))
  })

  it("includes repo-local path for Codex", () => {
    const paths = getAgentSettingsSearchPaths("codex", { homeDir, cwd })
    expect(paths).toContain(`${cwd}/.codex/hooks.json`)
  })

  it("includes both global and repo-local paths for Claude", () => {
    const paths = getAgentSettingsSearchPaths("claude", { homeDir, cwd })
    expect(paths).toContain(`${homeDir}/.claude/settings.json`)
    expect(paths).toContain(`${cwd}/.claude/settings.json`)
  })

  it("includes both global and repo-local paths for Cursor", () => {
    const paths = getAgentSettingsSearchPaths("cursor", { homeDir, cwd })
    expect(paths).toContain(`${homeDir}/.cursor/hooks.json`)
    expect(paths).toContain(`${cwd}/.cursor/hooks.json`)
  })

  it("includes both global and repo-local paths for Gemini", () => {
    const paths = getAgentSettingsSearchPaths("gemini", { homeDir, cwd })
    expect(paths).toContain(`${homeDir}/.gemini/settings.json`)
    expect(paths).toContain(`${cwd}/.gemini/settings.json`)
  })

  it("supports multi-layer discovery for Codex with global + repo-local", () => {
    const codexPaths = getAgentSettingsSearchPaths("codex", { homeDir, cwd })
    const globalPath = `${homeDir}/.codex/hooks.json`
    const localPath = `${cwd}/.codex/hooks.json`
    expect(codexPaths).toEqual([globalPath, localPath])
  })
})

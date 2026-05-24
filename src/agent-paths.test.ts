import { describe, expect, it } from "vitest"
import {
  detectCurrentAgentFromHookPayload,
  getAgentSettingsPath,
  getAgentSettingsSearchPaths,
} from "./agent-paths.ts"

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

  it("resolves Antigravity hooks under its dedicated hooks.json", () => {
    const paths = getAgentSettingsSearchPaths("antigravity", { homeDir, cwd })
    expect(paths[0]).toBe(getAgentSettingsPath("antigravity", homeDir))
    expect(paths).toEqual([
      `${homeDir}/.gemini/antigravity-cli/hooks.json`,
      `${cwd}/.gemini/antigravity-cli/hooks.json`,
    ])
  })
})

describe("detectCurrentAgentFromHookPayload _agent fast path", () => {
  it("returns the named agent when _agent is a valid id", () => {
    const agent = detectCurrentAgentFromHookPayload({ _agent: "claude" })
    expect(agent?.id).toBe("claude")
  })

  it("returns cursor when _agent is 'cursor'", () => {
    const agent = detectCurrentAgentFromHookPayload({ _agent: "cursor" })
    expect(agent?.id).toBe("cursor")
  })

  it("falls through to env detection when _agent is an unknown id", () => {
    const agent = detectCurrentAgentFromHookPayload({
      _agent: "unknown-agent-xyz",
      _env: { CLAUDECODE: "1" },
    })
    expect(agent?.id).toBe("claude")
  })

  it("returns null when payload is undefined", () => {
    const agent = detectCurrentAgentFromHookPayload(undefined)
    expect(agent).toBeNull()
  })

  it("prefers _agent over _env when both are present", () => {
    const agent = detectCurrentAgentFromHookPayload({
      _agent: "cursor",
      _env: { CLAUDECODE: "1" },
    })
    expect(agent?.id).toBe("cursor")
  })
})

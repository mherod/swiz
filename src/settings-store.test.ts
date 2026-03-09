import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsStore } from "./settings.ts"

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withTmpHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = join(
    tmpdir(),
    `settings-store-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(join(home, ".swiz"), { recursive: true })
  try {
    await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// ── setGlobal ─────────────────────────────────────────────────────────────────

describe("setGlobal", () => {
  test("writes a boolean setting to global settings file", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const path = await store.setGlobal("autoContinue", true)
      expect(path).toContain(".swiz/settings.json")
      const settings = await store.readGlobal()
      expect(settings.autoContinue).toBe(true)
    }))

  test("merges with existing global settings", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      await store.setGlobal("autoContinue", false)
      await store.setGlobal("speak", true)
      const settings = await store.readGlobal()
      expect(settings.autoContinue).toBe(false)
      expect(settings.speak).toBe(true)
    }))
})

// ── setProject ────────────────────────────────────────────────────────────────

describe("setProject", () => {
  test("writes a setting to project config.json", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const projectDir = join(home, "my-project")
      await mkdir(join(projectDir, ".swiz"), { recursive: true })
      const path = await store.setProject(projectDir, "memoryWordThreshold", 3000)
      expect(path).toContain("config.json")
      const project = await store.readProject(projectDir)
      expect(project?.memoryWordThreshold).toBe(3000)
    }))
})

// ── setSession ────────────────────────────────────────────────────────────────

describe("setSession", () => {
  test("writes a setting scoped to a session", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const sessionId = "test-session-abc"
      await store.setSession(sessionId, "autoContinue", true)
      const settings = await store.readGlobal()
      expect(settings.sessions[sessionId]?.autoContinue).toBe(true)
    }))

  test("preserves existing session keys when setting a new one", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const sessionId = "test-session-xyz"
      await store.setSession(sessionId, "autoContinue", true)
      await store.setSession(sessionId, "prMergeMode", false)
      const settings = await store.readGlobal()
      const sess = settings.sessions[sessionId]
      expect(sess?.autoContinue).toBe(true)
      expect(sess?.prMergeMode).toBe(false)
    }))

  test("initialises session from global autoContinue when no session exists yet", () =>
    withTmpHome(async (home) => {
      // Write a global setting first
      const settingsPath = join(home, ".swiz", "settings.json")
      await writeFile(settingsPath, JSON.stringify({ autoContinue: false }))
      const store = new SettingsStore({ home })
      const sessionId = "brand-new-session"
      await store.setSession(sessionId, "prMergeMode", true)
      const settings = await store.readGlobal()
      const sess = settings.sessions[sessionId]
      // autoContinue inherited from global (false), plus the new key
      expect(sess?.autoContinue).toBe(false)
      expect(sess?.prMergeMode).toBe(true)
    }))
})

// ── disableHook ───────────────────────────────────────────────────────────────

describe("disableHook", () => {
  test("adds hook to global disabled list", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const { alreadyDisabled } = await store.disableHook("global", "stop-github-ci.ts")
      expect(alreadyDisabled).toBe(false)
      const settings = await store.readGlobal()
      expect(settings.disabledHooks).toContain("stop-github-ci.ts")
    }))

  test("returns alreadyDisabled=true when hook is already in global list", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      await store.disableHook("global", "stop-github-ci.ts")
      const { alreadyDisabled } = await store.disableHook("global", "stop-github-ci.ts")
      expect(alreadyDisabled).toBe(true)
      // List should not have duplicate entries
      const settings = await store.readGlobal()
      expect(settings.disabledHooks?.filter((h) => h === "stop-github-ci.ts")).toHaveLength(1)
    }))

  test("adds hook to project disabled list", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const projectDir = join(home, "my-project")
      await mkdir(join(projectDir, ".swiz"), { recursive: true })
      const { alreadyDisabled } = await store.disableHook("project", "stop-lint.ts", projectDir)
      expect(alreadyDisabled).toBe(false)
      const project = await store.readProject(projectDir)
      expect(project?.disabledHooks).toContain("stop-lint.ts")
    }))
})

// ── enableHook ────────────────────────────────────────────────────────────────

describe("enableHook", () => {
  test("removes hook from global disabled list", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      await store.disableHook("global", "stop-github-ci.ts")
      const { wasEnabled } = await store.enableHook("global", "stop-github-ci.ts")
      expect(wasEnabled).toBe(true)
      const settings = await store.readGlobal()
      expect(settings.disabledHooks ?? []).not.toContain("stop-github-ci.ts")
    }))

  test("returns wasEnabled=false when hook is not in global list", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const { wasEnabled } = await store.enableHook("global", "not-disabled.ts")
      expect(wasEnabled).toBe(false)
    }))

  test("removes hook from project disabled list", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const projectDir = join(home, "my-project")
      await mkdir(join(projectDir, ".swiz"), { recursive: true })
      await store.disableHook("project", "stop-lint.ts", projectDir)
      const { wasEnabled } = await store.enableHook("project", "stop-lint.ts", projectDir)
      expect(wasEnabled).toBe(true)
      const project = await store.readProject(projectDir)
      expect(project?.disabledHooks ?? []).not.toContain("stop-lint.ts")
    }))
})

// ── effective ─────────────────────────────────────────────────────────────────

describe("effective", () => {
  test("returns global source when no session override", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const projectDir = join(home, "my-project")
      await mkdir(join(projectDir, ".swiz"), { recursive: true })
      const effective = await store.effective(projectDir)
      expect(effective.source).toBe("global")
    }))

  test("returns session source when session override exists", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const projectDir = join(home, "my-project")
      await mkdir(join(projectDir, ".swiz"), { recursive: true })
      const sessionId = "my-session"
      await store.setSession(sessionId, "autoContinue", true)
      const effective = await store.effective(projectDir, sessionId)
      expect(effective.source).toBe("session")
      expect(effective.autoContinue).toBe(true)
    }))

  test("project ambitionMode overrides global when no session", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const projectDir = join(home, "my-project")
      await mkdir(join(projectDir, ".swiz"), { recursive: true })
      await store.setProject(projectDir, "ambitionMode", "aggressive")
      const effective = await store.effective(projectDir)
      expect(effective.ambitionMode).toBe("aggressive")
    }))

  test("session ambitionMode falls back to project ambitionMode", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const projectDir = join(home, "my-project")
      await mkdir(join(projectDir, ".swiz"), { recursive: true })
      const sessionId = "session-project-ambition"
      await store.setProject(projectDir, "ambitionMode", "creative")
      await store.setSession(sessionId, "autoContinue", true)
      const effective = await store.effective(projectDir, sessionId)
      expect(effective.source).toBe("session")
      expect(effective.ambitionMode).toBe("creative")
    }))

  test("project largeFileSizeKb overrides global in effective settings", () =>
    withTmpHome(async (home) => {
      const store = new SettingsStore({ home })
      const projectDir = join(home, "my-project")
      await mkdir(join(projectDir, ".swiz"), { recursive: true })
      await store.setGlobal("largeFileSizeKb", 600)
      await store.setProject(projectDir, "largeFileSizeKb", 900)
      const globalEffective = await store.effective(projectDir)
      expect(globalEffective.largeFileSizeKb).toBe(900)

      const sessionId = "session-large-file"
      await store.setSession(sessionId, "autoContinue", true)
      const sessionEffective = await store.effective(projectDir, sessionId)
      expect(sessionEffective.largeFileSizeKb).toBe(900)
    }))
})

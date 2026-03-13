import { describe, expect, test } from "bun:test"

describe("settings module boundaries", () => {
  test("types.ts exports domain types and schemas", async () => {
    const mod = await import("./types.ts")
    expect(mod.policyProfileSchema).toBeDefined()
    expect(mod.ambitionModeSchema).toBeDefined()
    expect(mod.collaborationModeSchema).toBeDefined()
    expect(mod.projectStateSchema).toBeDefined()
    expect(mod.STATE_TRANSITIONS).toBeDefined()
    expect(mod.PROJECT_STATES).toBeDefined()
    expect(mod.ALL_STATUS_LINE_SEGMENTS).toBeDefined()
  })

  test("registry.ts exports SETTINGS_REGISTRY", async () => {
    const mod = await import("./registry.ts")
    expect(mod.SETTINGS_REGISTRY).toBeDefined()
    expect(Array.isArray(mod.SETTINGS_REGISTRY)).toBe(true)
    expect(mod.SETTINGS_REGISTRY.length).toBeGreaterThan(0)
  })

  test("resolution.ts exports policy and threshold logic", async () => {
    const mod = await import("./resolution.ts")
    expect(mod.resolvePolicy).toBeTypeOf("function")
    expect(mod.resolveMemoryThresholds).toBeTypeOf("function")
    expect(mod.getEffectiveSwizSettings).toBeTypeOf("function")
    expect(mod.POLICY_PROFILES).toBeDefined()
    expect(mod.DEFAULT_MEMORY_LINE_THRESHOLD).toBeDefined()
  })

  test("persistence.ts exports file I/O functions", async () => {
    const mod = await import("./persistence.ts")
    expect(mod.readSwizSettings).toBeTypeOf("function")
    expect(mod.writeSwizSettings).toBeTypeOf("function")
    expect(mod.readProjectSettings).toBeTypeOf("function")
    expect(mod.writeProjectSettings).toBeTypeOf("function")
    expect(mod.readStateData).toBeTypeOf("function")
    expect(mod.writeProjectState).toBeTypeOf("function")
    expect(mod.getSwizSettingsPath).toBeTypeOf("function")
    expect(mod.getProjectSettingsPath).toBeTypeOf("function")
  })

  test("store.ts exports SettingsStore class", async () => {
    const mod = await import("./store.ts")
    expect(mod.SettingsStore).toBeTypeOf("function")
    expect(mod.settingsStore).toBeDefined()
  })

  test("index.ts barrel re-exports all public API", async () => {
    const mod = await import("./index.ts")
    // Types
    expect(mod.policyProfileSchema).toBeDefined()
    expect(mod.ambitionModeSchema).toBeDefined()
    expect(mod.STATE_TRANSITIONS).toBeDefined()
    // Registry
    expect(mod.SETTINGS_REGISTRY).toBeDefined()
    // Resolution
    expect(mod.resolvePolicy).toBeTypeOf("function")
    expect(mod.getEffectiveSwizSettings).toBeTypeOf("function")
    // Persistence
    expect(mod.readSwizSettings).toBeTypeOf("function")
    expect(mod.writeSwizSettings).toBeTypeOf("function")
    // Store
    expect(mod.SettingsStore).toBeTypeOf("function")
    expect(mod.settingsStore).toBeDefined()
    // Constants
    expect(mod.DEFAULT_SETTINGS).toBeDefined()
    expect(mod.POLICY_PROFILES).toBeDefined()
  })

  test("no circular dependencies between modules", async () => {
    // Import each module — circular dependencies would cause infinite loops or missing exports
    const types = await import("./types.ts")
    const registry = await import("./registry.ts")
    const resolution = await import("./resolution.ts")
    const persistence = await import("./persistence.ts")
    const store = await import("./store.ts")

    // Verify each module loaded with expected exports (not empty from circular dep)
    expect(Object.keys(types).length).toBeGreaterThan(5)
    expect(Object.keys(registry).length).toBeGreaterThan(0)
    expect(Object.keys(resolution).length).toBeGreaterThan(3)
    expect(Object.keys(persistence).length).toBeGreaterThan(5)
    expect(Object.keys(store).length).toBeGreaterThan(1)
  })

  test("barrel import matches direct submodule imports", async () => {
    const barrel = await import("./index.ts")
    const types = await import("./types.ts")
    const registry = await import("./registry.ts")
    const resolution = await import("./resolution.ts")

    // Verify barrel re-exports match the source modules
    expect(barrel.policyProfileSchema).toBe(types.policyProfileSchema)
    expect(barrel.SETTINGS_REGISTRY).toBe(registry.SETTINGS_REGISTRY)
    expect(barrel.resolvePolicy).toBe(resolution.resolvePolicy)
    expect(barrel.POLICY_PROFILES).toBe(resolution.POLICY_PROFILES)
  })
})

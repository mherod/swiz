import { describe, expect, test } from "bun:test"
import { resolveSettingSourceTier, settingSourceLabel } from "./resolution"

/**
 * `settings show` used to label project overrides and built-in defaults alike as `(user)`,
 * pointing anyone investigating configuration at the wrong file (#900). The displayed value was
 * right; only its attributed source was wrong, which is the harder kind of error to notice.
 */
const none = new Set<string>()

describe("effective setting source resolution", () => {
  test("a value no tier set is a default", () => {
    expect(resolveSettingSourceTier("narratorSpeed", { globalExplicitKeys: none })).toBe("default")
  })

  test("a key present in the global file is user-sourced", () => {
    expect(
      resolveSettingSourceTier("narratorSpeed", { globalExplicitKeys: new Set(["narratorSpeed"]) })
    ).toBe("user")
  })

  test("a project override outranks the global file", () => {
    expect(
      resolveSettingSourceTier("pushGate", {
        globalExplicitKeys: new Set(["pushGate"]),
        projectSettings: { pushGate: false } as never,
      })
    ).toBe("project")
  })

  test("a session override outranks project and global", () => {
    expect(
      resolveSettingSourceTier("autoContinue", {
        globalExplicitKeys: new Set(["autoContinue"]),
        projectSettings: { autoContinue: true } as never,
        sessionSettings: { autoContinue: false },
      })
    ).toBe("session")
  })

  test("an explicit value equal to its default keeps its own source", () => {
    // The stored file still states the choice, so attributing it to "default" would send the
    // user looking in the wrong place — and would flip if the default later changed.
    expect(
      resolveSettingSourceTier("critiquesEnabled", {
        globalExplicitKeys: new Set(["critiquesEnabled"]),
      })
    ).toBe("user")
    expect(
      resolveSettingSourceTier("pushGate", {
        globalExplicitKeys: none,
        projectSettings: { pushGate: false } as never,
      })
    ).toBe("project")
  })

  test("an explicit false is a source, not an absence", () => {
    // A falsy-but-present value must not be mistaken for unset.
    expect(
      resolveSettingSourceTier("trunkMode", {
        globalExplicitKeys: none,
        projectSettings: { trunkMode: false } as never,
      })
    ).toBe("project")
  })

  test("an undefined field in a present tier does not claim the value", () => {
    expect(
      resolveSettingSourceTier("pushGate", {
        globalExplicitKeys: none,
        projectSettings: { pushGate: undefined, trunkMode: true } as never,
        sessionSettings: { autoContinue: true },
      })
    ).toBe("default")
  })

  test("settings unrelated to a configured one do not inherit its source", () => {
    const inputs = {
      globalExplicitKeys: none,
      projectSettings: { pushGate: false } as never,
    }
    expect(resolveSettingSourceTier("pushGate", inputs)).toBe("project")
    expect(resolveSettingSourceTier("speak", inputs)).toBe("default")
    expect(resolveSettingSourceTier("ambitionMode", inputs)).toBe("default")
  })

  test("an empty global object resolves the same as no file at all", () => {
    expect(resolveSettingSourceTier("speak", { globalExplicitKeys: none })).toBe("default")
    expect(
      resolveSettingSourceTier("speak", { globalExplicitKeys: none, projectSettings: null })
    ).toBe("default")
  })

  test("labels match the existing settings show vocabulary", () => {
    expect(settingSourceLabel("session")).toBe("(session)")
    expect(settingSourceLabel("project")).toBe("(project)")
    expect(settingSourceLabel("user")).toBe("(user)")
    expect(settingSourceLabel("default")).toBe("(default)")
  })
})

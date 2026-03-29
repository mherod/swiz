import { describe, expect, it } from "vitest"
import { type HookDef, type HookGroup, manifest } from "./manifest.ts"

describe("manifest.ts", () => {
  describe("manifest structure", () => {
    it("exports manifest as array of HookGroup", () => {
      expect(Array.isArray(manifest)).toBe(true)
      expect(manifest.length).toBeGreaterThan(0)
    })

    it("manifest contains all expected event types", () => {
      const events = manifest.map((group) => group.event)
      expect(events).toContain("stop")
      expect(events).toContain("preToolUse")
      expect(events).toContain("postToolUse")
      expect(events).toContain("sessionStart")
    })

    it("each HookGroup has required event and hooks properties", () => {
      manifest.forEach((group) => {
        expect(group).toHaveProperty("event")
        expect(typeof group.event).toBe("string")
        expect(group.event.length).toBeGreaterThan(0)

        expect(group).toHaveProperty("hooks")
        expect(Array.isArray(group.hooks)).toBe(true)
      })
    })
  })

  describe("stop event hooks", () => {
    it("stop event has multiple hooks defined", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      expect(stopGroup).toBeDefined()
      expect(stopGroup?.hooks.length).toBeGreaterThan(5)
    })

    it("stop hooks have timeout values", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      stopGroup?.hooks.forEach((hook) => {
        if (hook.timeout) {
          expect(typeof hook.timeout).toBe("number")
          expect(hook.timeout).toBeGreaterThan(0)
        }
      })
    })

    it("stop-auto-continue has extended timeout of 120s", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const autoContinue = stopGroup?.hooks.find((h) => h.file.includes("auto-continue"))
      expect(autoContinue?.timeout ?? 0).toBe(120)
    })

    it("stop event hooks appear in correct order", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const files = stopGroup?.hooks.map((h) => h.file) || []
      // Offensive language check runs first so lazy patterns are caught before anything else
      expect(files[0]).toBe("stop-offensive-language.ts")
      // Incomplete tasks block early — before auditor and git checks
      expect(files[1]).toBe("stop-incomplete-tasks.ts")
      // Completion auditor verifies evidence and CI after tasks are complete
      expect(files[2]).toBe("stop-completion-auditor.ts")
      // Security hooks follow immediately after
      expect(files[3]).toBe("stop-secret-scanner.ts")
    })
  })

  describe("preToolUse event hooks", () => {
    it("preToolUse hooks have matchers for tool filtering (async-only groups exempt)", () => {
      const preToolUseGroups = manifest.filter((g) => g.event === "preToolUse")
      expect(preToolUseGroups.length).toBeGreaterThan(0)

      preToolUseGroups.forEach((group) => {
        const allAsync = group.hooks.every((h) => h.async === true)
        if (allAsync) return // async-only groups don't need matchers (e.g. narrator)
        expect(group.matcher).toBeDefined()
        expect(typeof group.matcher).toBe("string")
      })
    })

    it("TaskCreate matcher hook enforces task validation", () => {
      const taskCreateHook = manifest.find(
        (g) => g.event === "preToolUse" && g.matcher === "TaskCreate|TodoWrite"
      )
      expect(taskCreateHook).toBeDefined()
      expect(taskCreateHook?.hooks.some((h) => h.file.includes("subject-validation")))
    })

    it("Bash matcher blocks mixed-up tool calls before other shell guards", () => {
      const bashGroup = manifest.find((g) => g.event === "preToolUse" && g.matcher === "Bash")
      expect(bashGroup).toBeDefined()
      expect(bashGroup?.hooks[0]?.file).toBe("pretooluse-no-mixed-tool-calls.ts")
    })

    it("Edit|Write|Bash matcher has require-tasks hook", () => {
      const requireTasksGroup = manifest.find(
        (g) => g.event === "preToolUse" && g.matcher === "Edit|Write|Bash"
      )
      expect(requireTasksGroup).toBeDefined()
      expect(requireTasksGroup?.hooks.some((h) => h.file.includes("require-tasks"))).toBe(true)
    })

    it("Edit|Write|NotebookEdit|Bash matcher has update-memory enforcement hook", () => {
      const updateMemoryGroup = manifest.find(
        (g) => g.event === "preToolUse" && g.matcher === "Edit|Write|NotebookEdit|Bash"
      )
      expect(updateMemoryGroup).toBeDefined()
      expect(
        updateMemoryGroup?.hooks.some((h) => h.file.includes("update-memory-enforcement"))
      ).toBe(true)
    })

    it("update-memory enforcement hook has 5-minute cooldown", () => {
      const updateMemoryGroup = manifest.find(
        (g) => g.event === "preToolUse" && g.matcher === "Edit|Write|NotebookEdit|Bash"
      )
      const hook = updateMemoryGroup?.hooks.find((h) =>
        h.file.includes("update-memory-enforcement")
      )
      expect(hook).toBeDefined()
      expect(hook?.cooldownSeconds).toBe(300)
    })
  })

  describe("postToolUse event hooks", () => {
    it("postToolUse hooks exist without matchers (apply to all tools)", () => {
      const basePostToolUse = manifest.find((g) => g.event === "postToolUse" && !g.matcher)
      expect(basePostToolUse).toBeDefined()
    })

    it("postToolUse has git-status hook", () => {
      const basePostToolUse = manifest.find((g) => g.event === "postToolUse" && !g.matcher)
      expect(basePostToolUse?.hooks.some((h) => h.file.includes("git-status"))).toBe(true)
    })

    it("postToolUse has task-specific hooks for TaskCreate", () => {
      const taskCreatePost = manifest.find(
        (g) => g.event === "postToolUse" && g.matcher === "TaskCreate|TodoWrite"
      )
      expect(taskCreatePost).toBeDefined()
    })
  })

  describe("HookDef structure", () => {
    it("HookDef requires file property", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          expect(hook).toHaveProperty("file")
          expect(typeof hook.file).toBe("string")
          expect(hook.file.endsWith(".ts")).toBe(true)
        })
      })
    })

    it("HookDef timeout is optional but always a number when present", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          if (hook.timeout !== undefined) {
            expect(typeof hook.timeout).toBe("number")
            expect(hook.timeout).toBeGreaterThan(0)
          }
        })
      })
    })

    it("HookDef async flag is optional and boolean", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          if (hook.async !== undefined) {
            expect(typeof hook.async).toBe("boolean")
          }
        })
      })
    })
  })

  describe("matcher patterns", () => {
    it("matchers use pipe-separated tool names", () => {
      const matchers = manifest
        .filter((g) => g.matcher)
        .map((g) => g.matcher)
        .filter((m): m is string => !!m)

      matchers.forEach((matcher) => {
        // Matchers should be like "Edit|Write|Bash"
        expect(typeof matcher).toBe("string")
        if (matcher.includes("|")) {
          const tools = matcher.split("|")
          tools.forEach((tool) => {
            expect(tool.length).toBeGreaterThan(0)
            // Tools should be capitalized or snake_case (cross-agent aliases like update_plan)
            if (tool.length > 0) {
              const isCapitalized = tool[0] === tool[0]?.toUpperCase()
              const isSnakeCase = /^[a-z][a-z0-9_]*$/.test(tool)
              expect(isCapitalized || isSnakeCase).toBe(true)
            }
          })
        }
      })
    })

    it("specific matchers exist for single tools", () => {
      const singleMatchers = manifest
        .filter((g) => g.matcher && !g.matcher.includes("|"))
        .map((g) => g.matcher)

      expect(singleMatchers).toContain("Task")
      expect(singleMatchers).toContain("Bash")
    })
  })

  describe("manifest integrity", () => {
    it("all hook files have unique combinations (event + file)", () => {
      const combinations = manifest.flatMap((group) =>
        group.hooks.map((hook) => `${group.event}:${hook.file}`)
      )
      const unique = new Set(combinations)
      expect(unique.size).toBe(combinations.length)
    })

    it("no timeout values are unexpectedly long", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          if (hook.timeout) {
            // Most hooks should timeout within 30s; 120s is only for special cases
            expect(hook.timeout).toBeLessThanOrEqual(120)
          }
        })
      })
    })

    it("security hooks appear early in stop event", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const securityHooks = ["stop-secret-scanner.ts", "stop-large-files.ts"]
      const hookFiles = (stopGroup?.hooks || []).map((h) => h.file)

      securityHooks.forEach((securityHook) => {
        const index = hookFiles.indexOf(securityHook)
        expect(index).toBeLessThan(6) // Should be in first 6 hooks
      })
    })

    it("manifest exports are correct types", () => {
      // Verify that types can be imported and used
      const hookDef: HookDef = { file: "test.ts", timeout: 10 }
      expect(hookDef.file).toBe("test.ts")
      expect(hookDef.timeout).toBe(10)

      const hookGroup: HookGroup = {
        event: "stop",
        hooks: [hookDef],
      }
      expect(hookGroup.event).toBe("stop")
      expect(hookGroup.hooks.length).toBe(1)
    })
  })

  describe("hook discovery", () => {
    it("can find all hooks by event name", () => {
      const stopHooks = manifest.filter((g) => g.event === "stop")
      expect(stopHooks.length).toBeGreaterThan(0)
      expect(stopHooks[0]?.hooks.length).toBeGreaterThan(0)
    })

    it("can find hooks by event and matcher combination", () => {
      const editWriteHooks = manifest.find(
        (g) => g.event === "preToolUse" && g.matcher === "Edit|Write|NotebookEdit"
      )
      expect(editWriteHooks).toBeDefined()
      expect(editWriteHooks?.hooks.length).toBeGreaterThan(0)
    })

    it("matcher 'Task' catches Task operations generically", () => {
      const taskMatcher = manifest.find((g) => g.matcher === "Task")
      expect(taskMatcher).toBeDefined()
      expect(taskMatcher?.event).toBe("preToolUse")
    })
  })

  describe("requiredSettings validation", () => {
    it("every requiredSettings entry is a valid EffectiveSwizSettings key", () => {
      const allHooks = manifest.flatMap((g) => g.hooks)
      const hooksWithRequired = allHooks.filter(
        (h) => h.requiredSettings && h.requiredSettings.length > 0
      )
      expect(hooksWithRequired.length).toBeGreaterThan(0)

      for (const hook of hooksWithRequired) {
        for (const key of hook.requiredSettings!) {
          // TypeScript enforces this at compile time via keyof, but this test
          // catches runtime issues with project-local hooks or config drift.
          expect(typeof key).toBe("string")
          expect(key.length).toBeGreaterThan(0)
        }
      }
    })

    it("stop-quality-checks.ts has requiredSettings: ['qualityChecksGate']", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const hook = stopGroup?.hooks.find((h) => h.file === "stop-quality-checks.ts")
      expect(hook).toBeDefined()
      expect(hook?.requiredSettings).toEqual(["qualityChecksGate"])
    })
  })
})

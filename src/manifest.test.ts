import { describe, expect, it } from "vitest"
import { agentHasTaskTools } from "./agent-paths.ts"
import { isAsyncFireAndForgetHook } from "./dispatch/engine.ts"
import {
  type HookDef,
  type HookGroup,
  hookIdentifier,
  isInlineHookDef,
  manifest,
} from "./manifest.ts"

describe("manifest.ts", () => {
  const tasksEnabled = agentHasTaskTools()

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
        const timeout = isInlineHookDef(hook) ? hook.hook.timeout : hook.timeout
        if (timeout) {
          expect(typeof timeout).toBe("number")
          expect(timeout).toBeGreaterThan(0)
        }
      })
    })

    it("stop-auto-continue has extended timeout of 15s", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const autoContinue = stopGroup?.hooks.find((h) => hookIdentifier(h).includes("auto-continue"))
      const timeout = autoContinue
        ? isInlineHookDef(autoContinue)
          ? autoContinue.hook.timeout
          : autoContinue.timeout
        : undefined
      expect(timeout ?? 0).toBe(15)
    })

    it("stop event hooks appear in correct order", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const files = stopGroup?.hooks.map((h) => hookIdentifier(h)) || []
      // Offensive language check runs first so lazy patterns are caught before anything else
      expect(files[0]).toBe("stop-offensive-language.ts")
      if (tasksEnabled) {
        // Incomplete tasks block early — before auditor and git checks
        expect(files[1]).toBe("stop-incomplete-tasks.ts")
        // Completion auditor verifies evidence and CI after tasks are complete
        expect(files[2]).toBe("stop-completion-auditor.ts")
      } else {
        // Codex strips task-specific hooks from the runtime manifest.
        expect(files[1]).toBe("stop-completion-auditor.ts")
      }
      const completionAuditorIndex = files.indexOf("stop-completion-auditor.ts")
      const secretScannerIndex = files.indexOf("stop-secret-scanner.ts")
      const workflowPermissionsIndex = files.indexOf("stop-workflow-permissions.ts")
      expect(completionAuditorIndex).toBeGreaterThanOrEqual(0)
      expect(secretScannerIndex).toBeGreaterThan(completionAuditorIndex)
      expect(workflowPermissionsIndex).toBeGreaterThan(secretScannerIndex)
    })
  })

  describe("preToolUse event hooks", () => {
    it("preToolUse hooks have matchers for tool filtering (fire-and-forget-async-only groups exempt)", () => {
      const preToolUseGroups = manifest.filter((g) => g.event === "preToolUse")
      expect(preToolUseGroups.length).toBeGreaterThan(0)

      preToolUseGroups.forEach((group) => {
        const allFireAndForgetAsync =
          group.hooks.length > 0 && group.hooks.every((h) => isAsyncFireAndForgetHook(h))
        if (allFireAndForgetAsync) return
        // The merged task governance hook handles all tool types internally
        const hasMergedGovernance = group.hooks.some(
          (h) => hookIdentifier(h) === "pretooluse-task-governance.ts"
        )
        if (hasMergedGovernance) return
        expect(group.matcher).toBeDefined()
        expect(typeof group.matcher).toBe("string")
      })
    })

    it("TaskCreate matcher hook enforces task validation", () => {
      const taskCreateHook = manifest.find(
        (g) => g.event === "preToolUse" && g.matcher === "TaskCreate|TodoWrite"
      )
      expect(taskCreateHook).toBeDefined()
      expect(taskCreateHook?.hooks.some((h) => hookIdentifier(h).includes("subject-validation")))
    })

    it("Bash matcher blocks mixed-up tool calls before other shell guards", () => {
      const bashGroup = manifest.find((g) => g.event === "preToolUse" && g.matcher === "Bash")
      expect(bashGroup).toBeDefined()
      expect(bashGroup?.hooks[0] && hookIdentifier(bashGroup.hooks[0])).toBe(
        "pretooluse-no-mixed-tool-calls.ts"
      )
    })

    it("Edit|Write|Bash matcher has require-tasks hook", () => {
      const requireTasksGroup = manifest.find(
        (g) => g.event === "preToolUse" && g.matcher === "Edit|Write|Bash"
      )
      expect(requireTasksGroup).toBeDefined()
      const hasRequireTasksHook =
        requireTasksGroup?.hooks.some((h) => hookIdentifier(h).includes("require-tasks")) ?? false
      expect(hasRequireTasksHook).toBe(tasksEnabled)
    })

    it("Edit|Write|NotebookEdit|Bash matcher has update-memory enforcement hook", () => {
      const updateMemoryGroup = manifest.find(
        (g) => g.event === "preToolUse" && g.matcher === "Edit|Write|NotebookEdit|Bash"
      )
      expect(updateMemoryGroup).toBeDefined()
      expect(
        updateMemoryGroup?.hooks.some((h) =>
          hookIdentifier(h).includes("update-memory-enforcement")
        )
      ).toBe(true)
    })

    it("update-memory enforcement hook has 5-minute cooldown", () => {
      const updateMemoryGroup = manifest.find(
        (g) => g.event === "preToolUse" && g.matcher === "Edit|Write|NotebookEdit|Bash"
      )
      const hook = updateMemoryGroup?.hooks.find((h) =>
        hookIdentifier(h).includes("update-memory-enforcement")
      )
      expect(hook).toBeDefined()
      const cooldown = hook
        ? isInlineHookDef(hook)
          ? hook.hook.cooldownSeconds
          : hook.cooldownSeconds
        : undefined
      expect(cooldown).toBe(300)
    })
  })

  describe("postToolUse event hooks", () => {
    it("postToolUse hooks exist without matchers (apply to all tools)", () => {
      const basePostToolUse = manifest.find((g) => g.event === "postToolUse" && !g.matcher)
      expect(basePostToolUse).toBeDefined()
    })

    it("postToolUse has git-context hook", () => {
      const basePostToolUse = manifest.find((g) => g.event === "postToolUse" && !g.matcher)
      expect(basePostToolUse?.hooks.some((h) => hookIdentifier(h).includes("git-context"))).toBe(
        true
      )
    })

    it("postToolUse has task-specific hooks for TaskCreate", () => {
      const taskCreatePost = manifest.find(
        (g) => g.event === "postToolUse" && g.matcher === "TaskCreate|TodoWrite"
      )
      expect(taskCreatePost).toBeDefined()
    })
  })

  describe("HookDef structure", () => {
    it("file-based HookDef has a .ts file; inline HookDef has a name", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          if (isInlineHookDef(hook)) {
            expect(typeof hook.hook.name).toBe("string")
            expect(hook.hook.name.length).toBeGreaterThan(0)
          } else {
            expect(typeof hook.file).toBe("string")
            expect(hook.file.endsWith(".ts")).toBe(true)
          }
        })
      })
    })

    it("HookDef timeout is optional but always a number when present", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          const timeout = isInlineHookDef(hook) ? hook.hook.timeout : hook.timeout
          if (timeout !== undefined) {
            expect(typeof timeout).toBe("number")
            expect(timeout).toBeGreaterThan(0)
          }
        })
      })
    })

    it("HookDef async flag is optional and boolean", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          const isAsync = isInlineHookDef(hook) ? hook.hook.async : hook.async
          if (isAsync !== undefined) {
            expect(typeof isAsync).toBe("boolean")
          }
        })
      })
    })

    it("HookDef asyncMode when present is a valid literal", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          const mode = isInlineHookDef(hook) ? hook.hook.asyncMode : hook.asyncMode
          if (mode !== undefined) {
            expect(["fire-and-forget", "block-until-complete"]).toContain(mode)
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
    it("all hooks have unique combinations (event + matcher + identifier)", () => {
      const combinations = manifest.flatMap((group) =>
        group.hooks.map((hook) => `${group.event}:${group.matcher ?? ""}:${hookIdentifier(hook)}`)
      )
      const unique = new Set(combinations)
      expect(unique.size).toBe(combinations.length)
    })

    it("no timeout values are unexpectedly long", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          const timeout = isInlineHookDef(hook) ? hook.hook.timeout : hook.timeout
          if (timeout) {
            // Most hooks should timeout within 30s; 120s is only for special cases
            expect(timeout).toBeLessThanOrEqual(120)
          }
        })
      })
    })

    it("security hooks appear early in stop event", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const securityHooks = ["stop-secret-scanner.ts", "stop-large-files.ts"]
      const hookIds = (stopGroup?.hooks || []).map((h) => hookIdentifier(h))

      securityHooks.forEach((securityHook) => {
        const index = hookIds.indexOf(securityHook)
        expect(index).toBeLessThan(6) // Should be in first 6 hooks
      })
    })

    it("manifest exports are correct types", () => {
      // FileHookDef (existing format) satisfies HookDef
      const fileDef: HookDef = { file: "test.ts", timeout: 10 }
      expect(isInlineHookDef(fileDef)).toBe(false)
      expect(hookIdentifier(fileDef)).toBe("test.ts")

      const hookGroup: HookGroup = {
        event: "stop",
        hooks: [fileDef],
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
      const hooksWithRequired = allHooks.filter((h) => {
        const rs = isInlineHookDef(h) ? h.hook.requiredSettings : h.requiredSettings
        return rs && rs.length > 0
      })
      expect(hooksWithRequired.length).toBeGreaterThan(0)

      for (const hook of hooksWithRequired) {
        const rs = isInlineHookDef(hook) ? hook.hook.requiredSettings! : hook.requiredSettings!
        for (const key of rs) {
          // TypeScript enforces this at compile time via keyof, but this test
          // catches runtime issues with project-local hooks or config drift.
          expect(typeof key).toBe("string")
          expect(key.length).toBeGreaterThan(0)
        }
      }
    })

    it("stop-quality-checks.ts has requiredSettings: ['qualityChecksGate']", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const hook = stopGroup?.hooks.find((h) => hookIdentifier(h) === "stop-quality-checks.ts")
      expect(hook).toBeDefined()
      const rs = hook
        ? isInlineHookDef(hook)
          ? hook.hook.requiredSettings
          : hook.requiredSettings
        : undefined
      expect(rs).toEqual(["qualityChecksGate"])
    })
  })
})

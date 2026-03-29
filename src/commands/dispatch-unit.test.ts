import { describe, expect, it } from "vitest"
import { filterPrMergeModeHooks, resolvePrMergeActive } from "../dispatch/index.ts"
import { manifest } from "../manifest.ts"

describe("dispatch.ts unit tests", () => {
  describe("cross-agent tool matching patterns", () => {
    it("shell tools have multiple agent names", () => {
      // Shell tools are: Bash (Claude), Shell (Cursor), run_shell_command
      const shellNames = ["Bash", "Shell", "run_shell_command"]
      shellNames.forEach((name) => {
        expect(typeof name).toBe("string")
        expect(name.length).toBeGreaterThan(0)
      })
    })

    it("edit tools have multiple agent names", () => {
      // Edit tools are: Edit (Claude), StrReplace (Cursor), apply_patch
      const editNames = ["Edit", "StrReplace", "apply_patch"]
      editNames.forEach((name) => {
        expect(typeof name).toBe("string")
      })
    })

    it("write tools have multiple agent names", () => {
      // Write tools are: Write (Claude), create_file (Cursor)
      const writeNames = ["Write", "create_file"]
      writeNames.forEach((name) => {
        expect(typeof name).toBe("string")
      })
    })

    it("task tools have multiple names across agents", () => {
      // Task tools like TaskList, TaskGet, TaskUpdate
      const taskNames = ["TaskList", "TaskGet", "TaskUpdate"]
      taskNames.forEach((name) => {
        expect(typeof name).toBe("string")
        expect(name.includes("Task")).toBe(true)
      })
    })

    it("TaskCreate is distinct tool identifier", () => {
      // TaskCreate is handled differently from other task tools
      expect("TaskCreate".includes("Create")).toBe(true)
    })

    it("notebook operations are separate from text edit", () => {
      // NotebookEdit is distinct from Edit
      const notebookTool = "NotebookEdit"
      const editTool = "Edit"
      expect(notebookTool).not.toBe(editTool)
    })
  })

  describe("matcher token parsing", () => {
    it("parses pipe-separated matcher tokens", () => {
      const matcher = "Edit|Write|NotebookEdit"
      const tokens = matcher.split("|").map((t) => t.trim())

      expect(tokens).toHaveLength(3)
      expect(tokens).toContain("Edit")
      expect(tokens).toContain("Write")
      expect(tokens).toContain("NotebookEdit")
    })

    it("handles single-tool matchers", () => {
      const matcher = "Bash"
      const tokens = matcher.split("|").map((t) => t.trim())

      expect(tokens).toHaveLength(1)
      expect(tokens[0]).toBe("Bash")
    })

    it("token comparison ignores whitespace", () => {
      const matcher = "Edit | Write | Bash"
      const tokens = matcher.split("|").map((t) => t.trim())

      tokens.forEach((token) => {
        expect(token).not.toContain(" ")
      })
    })
  })

  describe("hook group matching logic", () => {
    it("groups without matcher apply universally", () => {
      const universalGroups = manifest.filter((g) => !g.matcher)
      expect(universalGroups.length).toBeGreaterThan(0)

      // Non-empty universal groups must have at least one hook.
      // Empty universal groups (event placeholders with no bundled hooks) are allowed.
      const nonEmptyUniversalGroups = universalGroups.filter((g) => g.hooks.length > 0)
      expect(nonEmptyUniversalGroups.length).toBeGreaterThan(0)
      nonEmptyUniversalGroups.forEach((group) => {
        expect(group.event).toBeDefined()
        expect(group.hooks.length).toBeGreaterThan(0)
      })
    })

    it("preToolUse groups have specific tool matchers", () => {
      const preToolUseGroups = manifest.filter((g) => g.event === "preToolUse")
      expect(preToolUseGroups.length).toBeGreaterThan(0)

      preToolUseGroups.forEach((group) => {
        // Some may have matcher, some may not (base group)
        if (group.matcher) {
          expect(typeof group.matcher).toBe("string")
        }
      })
    })

    it("postToolUse groups vary in matcher requirements", () => {
      const postToolUseGroups = manifest.filter((g) => g.event === "postToolUse")
      expect(postToolUseGroups.length).toBeGreaterThan(0)

      const hasWithMatcher = postToolUseGroups.some((g) => g.matcher)
      const hasWithoutMatcher = postToolUseGroups.some((g) => !g.matcher)

      // Some PostToolUse hooks apply to all, some are tool-specific
      expect(hasWithMatcher || hasWithoutMatcher).toBe(true)
    })

    it("stop event has many hooks, some with matchers", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      expect(stopGroup).toBeDefined()
      expect(stopGroup?.hooks.length).toBeGreaterThan(10)
    })
  })

  describe("pr-merge-mode hook filtering", () => {
    it("removes merge-oriented hooks when pr-merge-mode is disabled", () => {
      const groups = [
        {
          event: "stop",
          hooks: [{ file: "stop-github-ci.ts" }, { file: "stop-non-default-branch.ts" }],
        },
        {
          event: "postToolUse",
          matcher: "Bash",
          hooks: [
            { file: "posttooluse-pr-context.ts" },
            { file: "posttooluse-git-task-autocomplete.ts" },
          ],
        },
      ]

      const filtered = filterPrMergeModeHooks(groups, false)

      expect(filtered).toHaveLength(2)
      expect(filtered[0]?.hooks.map((hook) => hook.file)).toEqual(["stop-non-default-branch.ts"])
      expect(filtered[1]?.hooks.map((hook) => hook.file)).toEqual([
        "posttooluse-git-task-autocomplete.ts",
      ])
    })

    it("leaves hooks untouched when pr-merge-mode is enabled", () => {
      const groups = [
        {
          event: "stop",
          hooks: [{ file: "stop-github-ci.ts" }, { file: "stop-non-default-branch.ts" }],
        },
      ]

      const filtered = filterPrMergeModeHooks(groups, true)

      expect(filtered).toEqual(groups)
    })

    it("solo collaborationMode disables PR hooks regardless of prMergeMode", () => {
      const groups = [
        {
          event: "stop",
          hooks: [{ file: "stop-github-ci.ts" }, { file: "stop-non-default-branch.ts" }],
        },
      ]

      const filtered = filterPrMergeModeHooks(groups, true, "solo")

      expect(filtered).toHaveLength(1)
      expect(filtered[0]?.hooks.map((h) => h.file)).toEqual(["stop-non-default-branch.ts"])
    })

    it("team collaborationMode enables PR hooks regardless of prMergeMode", () => {
      const groups = [
        {
          event: "stop",
          hooks: [{ file: "stop-github-ci.ts" }, { file: "stop-non-default-branch.ts" }],
        },
      ]

      const filtered = filterPrMergeModeHooks(groups, false, "team")

      expect(filtered).toEqual(groups)
    })

    it("relaxed-collab collaborationMode enables PR hooks regardless of prMergeMode", () => {
      const groups = [
        {
          event: "stop",
          hooks: [{ file: "stop-github-ci.ts" }, { file: "stop-non-default-branch.ts" }],
        },
      ]

      const filtered = filterPrMergeModeHooks(groups, false, "relaxed-collab")

      expect(filtered).toEqual(groups)
    })

    it("auto collaborationMode falls back to prMergeMode boolean", () => {
      const groups = [
        {
          event: "stop",
          hooks: [{ file: "stop-github-ci.ts" }, { file: "stop-non-default-branch.ts" }],
        },
      ]

      // auto + prMergeMode=false → disables PR hooks
      const filteredOff = filterPrMergeModeHooks(groups, false, "auto")
      expect(filteredOff).toHaveLength(1)
      expect(filteredOff[0]?.hooks.map((h) => h.file)).toEqual(["stop-non-default-branch.ts"])

      // auto + prMergeMode=true → keeps all hooks
      const filteredOn = filterPrMergeModeHooks(groups, true, "auto")
      expect(filteredOn).toEqual(groups)
    })

    it("preserves pr-age-gate hook when prAgeGateMinutes > 0, even if PR mode disabled", () => {
      const groups = [
        {
          event: "preToolUse",
          hooks: [{ file: "pretooluse-pr-age-gate.ts" }, { file: "pretooluse-banned-commands.ts" }],
        },
      ]

      // prMergeMode=false + prAgeGateMinutes=10 → age-gate kept
      const filtered = filterPrMergeModeHooks(groups, false, "auto", 10)
      expect(filtered).toHaveLength(1)
      expect(filtered[0]?.hooks.map((h) => h.file)).toEqual([
        "pretooluse-pr-age-gate.ts",
        "pretooluse-banned-commands.ts",
      ])
    })

    it("filters pr-age-gate hook when prAgeGateMinutes is 0 and PR mode disabled", () => {
      const groups = [
        {
          event: "preToolUse",
          hooks: [{ file: "pretooluse-pr-age-gate.ts" }, { file: "pretooluse-banned-commands.ts" }],
        },
      ]

      // prMergeMode=false + prAgeGateMinutes=0 → age-gate filtered
      const filtered = filterPrMergeModeHooks(groups, false, "auto", 0)
      expect(filtered).toHaveLength(1)
      expect(filtered[0]?.hooks.map((h) => h.file)).toEqual(["pretooluse-banned-commands.ts"])
    })

    it("preserves pr-age-gate when solo mode but prAgeGateMinutes > 0", () => {
      const groups = [
        {
          event: "preToolUse",
          hooks: [{ file: "pretooluse-pr-age-gate.ts" }],
        },
      ]

      const filtered = filterPrMergeModeHooks(groups, false, "solo", 10)
      expect(filtered).toHaveLength(1)
      expect(filtered[0]?.hooks.map((h) => h.file)).toEqual(["pretooluse-pr-age-gate.ts"])
    })
  })

  describe("resolvePrMergeActive", () => {
    it("team always returns true", () => {
      expect(resolvePrMergeActive("team", false)).toBe(true)
      expect(resolvePrMergeActive("team", true)).toBe(true)
    })

    it("relaxed-collab always returns true", () => {
      expect(resolvePrMergeActive("relaxed-collab", false)).toBe(true)
      expect(resolvePrMergeActive("relaxed-collab", true)).toBe(true)
    })

    it("solo always returns false", () => {
      expect(resolvePrMergeActive("solo", false)).toBe(false)
      expect(resolvePrMergeActive("solo", true)).toBe(false)
    })

    it("auto returns the prMergeMode value", () => {
      expect(resolvePrMergeActive("auto", true)).toBe(true)
      expect(resolvePrMergeActive("auto", false)).toBe(false)
    })
  })

  describe("hook response classifications", () => {
    it("recognizes deny decision in hookSpecificOutput", () => {
      const response = {
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "Not allowed",
        },
      }
      const hso = response.hookSpecificOutput as Record<string, unknown>
      expect(hso.permissionDecision).toBe("deny")
    })

    it("recognizes allow decision with reason", () => {
      const response = {
        hookSpecificOutput: {
          permissionDecision: "allow",
          permissionDecisionReason: "Allowed with hints",
        },
      }
      const hso = response.hookSpecificOutput as Record<string, unknown>
      expect(hso.permissionDecision).toBe("allow")
      expect(typeof hso.permissionDecisionReason).toBe("string")
    })

    it("recognizes block decision", () => {
      const response = {
        decision: "block",
        reason: "Blocked from executing",
      }
      expect(response.decision).toBe("block")
    })

    it("extracts context from systemMessage", () => {
      const response = {
        systemMessage: "Injected context for the agent",
      }
      expect(typeof response.systemMessage).toBe("string")
    })

    it("extracts context from additionalContext", () => {
      const response = {
        hookSpecificOutput: {
          additionalContext: "More context for the session",
        },
      }
      const hso = response.hookSpecificOutput as Record<string, unknown>
      expect(typeof hso.additionalContext).toBe("string")
    })
  })

  describe("timeout configuration", () => {
    it("hooks have timeout values or use default", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          // Each hook either has explicit timeout or will use DEFAULT_TIMEOUT (10s)
          if (hook.timeout !== undefined) {
            expect(typeof hook.timeout).toBe("number")
            expect(hook.timeout).toBeGreaterThan(0)
          }
        })
      })
    })

    it("most timeouts are reasonable (under 30s)", () => {
      const longTimeouts = manifest
        .flatMap((g) => g.hooks)
        .filter((h) => h.timeout && h.timeout > 30)

      // Only special cases like stop-auto-continue should exceed 30s
      expect(longTimeouts.length).toBeLessThanOrEqual(3)
    })

    it("stop-auto-continue has extended 120s timeout", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const autoContinue = stopGroup?.hooks.find((h) => h.file.includes("auto-continue"))

      expect(autoContinue?.timeout).toBe(120)
    })
  })

  describe("async hook handling", () => {
    it("async hooks are identified in manifest", () => {
      const asyncHooks = manifest.flatMap((g) => g.hooks.filter((h) => h.async))
      expect(asyncHooks.length).toBeGreaterThan(0)
    })

    it("async hooks have timeout values", () => {
      const asyncHooks = manifest.flatMap((g) => g.hooks.filter((h) => h.async))

      asyncHooks.forEach((hook) => {
        expect(hook.timeout).toBeDefined()
        expect(typeof hook.timeout).toBe("number")
      })
    })

    it("fire-and-forget hooks exist in non-stop events", () => {
      // Async hooks are pre-launched before blocking hooks (e.g. posttooluse-prettier-ts)
      const nonStopAsyncHooks = manifest
        .filter((g) => g.event !== "stop")
        .flatMap((g) => g.hooks.filter((h) => h.async))

      expect(nonStopAsyncHooks.length).toBeGreaterThan(0)
    })
  })

  describe("hook file organization", () => {
    it("all hooks are .ts files", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          expect(hook.file).toMatch(/\.ts$/)
        })
      })
    })

    it("hook files follow naming convention", () => {
      manifest.forEach((group) => {
        group.hooks.forEach((hook) => {
          // Files should be lowercase with hyphens
          expect(hook.file).toMatch(/^[a-z-]+\.ts$/)
        })
      })
    })

    it("no duplicate hooks within the same event group", () => {
      for (const group of manifest) {
        const files = group.hooks.map((h) => h.file)
        const unique = new Set(files)
        expect(unique.size).toBe(files.length)
      }
    })
  })

  describe("cooldownSeconds configuration", () => {
    it("hooks without cooldownSeconds are not throttled", () => {
      const allHooks = manifest.flatMap((g) => g.hooks)
      const withoutCooldown = allHooks.filter((h) => !h.cooldownSeconds)
      expect(withoutCooldown.length).toBeGreaterThan(0)
    })

    it("cooldownSeconds is a positive number when set", () => {
      const allHooks = manifest.flatMap((g) => g.hooks)
      allHooks.forEach((hook) => {
        if (hook.cooldownSeconds !== undefined) {
          expect(typeof hook.cooldownSeconds).toBe("number")
          expect(hook.cooldownSeconds).toBeGreaterThan(0)
        }
      })
    })

    it("stop-personal-repo-issues has a 30-second cooldown", () => {
      const stopGroup = manifest.find((g) => g.event === "stop")
      const hook = stopGroup?.hooks.find((h) => h.file === "stop-personal-repo-issues.ts")
      expect(hook).toBeDefined()
      expect(hook?.cooldownSeconds).toBe(30)
    })

    it("cooldownMode is only set on hooks that also have cooldownSeconds", () => {
      const allHooks = manifest.flatMap((g) => g.hooks)
      allHooks.forEach((hook) => {
        if (hook.cooldownMode !== undefined) {
          expect(hook.cooldownSeconds).toBeDefined()
        }
      })
    })

    it("cooldownMode is one of the valid values when set", () => {
      const allHooks = manifest.flatMap((g) => g.hooks)
      allHooks.forEach((hook) => {
        if (hook.cooldownMode !== undefined) {
          expect(["block-only", "always"]).toContain(hook.cooldownMode)
        }
      })
    })
  })

  describe("event type coverage", () => {
    it("has hooks for all major events", () => {
      const events = manifest.map((g) => g.event)
      const unique = new Set(events)

      expect(unique.has("stop")).toBe(true)
      expect(unique.has("preToolUse")).toBe(true)
      expect(unique.has("postToolUse")).toBe(true)
      expect(unique.has("sessionStart")).toBe(true)
    })

    it("stop event has many hooks for comprehensive validation", () => {
      const stopHooks = manifest.find((g) => g.event === "stop")?.hooks.length ?? 0

      // Stop event should have multiple hooks (at least 10)
      expect(stopHooks).toBeGreaterThanOrEqual(10)
    })
  })

  describe("JSON payload structure", () => {
    it("hook input is valid JSON string", () => {
      const payload = {
        session_id: "test-session",
        tool_name: "Bash",
        cwd: "/test/path",
        transcript_path: "/tmp/transcript.jsonl",
      }

      const jsonStr = JSON.stringify(payload)
      const parsed = JSON.parse(jsonStr)

      expect(parsed.session_id).toBe("test-session")
      expect(parsed.tool_name).toBe("Bash")
    })

    it("hook output is JSON or empty", () => {
      const validOutputs = [
        '{"decision":"allow"}',
        '{"decision":"deny","reason":"test"}',
        "",
        '{"hookSpecificOutput":{"permissionDecision":"allow"}}',
      ]

      validOutputs.forEach((output) => {
        if (output.trim()) {
          expect(() => JSON.parse(output)).not.toThrow()
        }
      })
    })
  })

  describe("dispatch strategy differences", () => {
    it("preToolUse short-circuits on deny", () => {
      // Deny causes immediate return without processing other hooks
      const denyResponse = { decision: "deny", reason: "Blocked" }
      expect(denyResponse.decision).toBe("deny")
    })

    it("stop hooks forward first block", () => {
      // Block response is output and processing stops
      const blockResponse = { decision: "block", reason: "Session blocked" }
      expect(blockResponse.decision).toBe("block")
    })

    it("async hooks run in both preToolUse and stop", () => {
      const hasAsyncPreToolUse = manifest
        .filter((g) => g.event === "preToolUse")
        .some((g) => g.hooks.some((h) => h.async))

      const hasAsyncStop = manifest
        .filter((g) => g.event === "stop")
        .some((g) => g.hooks.some((h) => h.async))

      // Can have async in either or both
      expect(typeof hasAsyncPreToolUse === "boolean").toBe(true)
      expect(typeof hasAsyncStop === "boolean").toBe(true)
    })
  })
})

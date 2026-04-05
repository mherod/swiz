/**
 * Hook messaging methodology conformance tests.
 *
 * Validates that tier 4 hooks (PreToolUse denials and Stop blocks) use the
 * canonical output helpers rather than raw JSON output. The helpers automatically
 * append the ACTION REQUIRED footer and format messages consistently.
 *
 * See docs/hook-messaging-methodology.md for the full 4-tier model.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const HOOKS_DIR = join(import.meta.dirname ?? ".", "..", "hooks")

/** Hooks that intentionally bypass standard output helpers with documented reasons. */
const EXEMPTIONS: Record<string, string> = {
  // stop-auto-continue uses blockStopRaw by design — triggers continuation, not remediation
  "stop-auto-continue.ts": "uses blockStopRaw to trigger continuation without footer",
}

function readHookFiles(pattern: RegExp): Array<{ name: string; content: string }> {
  const files = readdirSync(HOOKS_DIR).filter(
    (f) => pattern.test(f) && f.endsWith(".ts") && !f.includes(".test.")
  )
  return files.map((name) => ({
    name,
    content: readFileSync(join(HOOKS_DIR, name), "utf8"),
  }))
}

describe("hook messaging conformance", () => {
  describe("PreToolUse hooks use canonical denial helpers", () => {
    const hooks = readHookFiles(/^pretooluse-/)

    it("no pretooluse hook writes raw JSON to stdout for denials", () => {
      const violations: string[] = []

      for (const { name, content } of hooks) {
        if (EXEMPTIONS[name]) continue

        // Check for raw console.log with permissionDecision patterns
        const hasRawDeny = /console\.log\s*\(\s*JSON\.stringify\s*\([^)]*permissionDecision/.test(
          content
        )

        if (hasRawDeny) {
          violations.push(`${name}: uses raw JSON.stringify for denial instead of preToolUseDeny()`)
        }
      }

      expect(violations).toEqual([])
    })

    it("every pretooluse hook with a denial imports from SwizHook or hook-utils", () => {
      const violations: string[] = []

      for (const { name, content } of hooks) {
        if (EXEMPTIONS[name]) continue

        // Check if hook has any denial call
        const hasDeny = content.includes("preToolUseDeny(") || content.includes("denyPreToolUse(")

        if (!hasDeny) continue

        // Verify it imports from the canonical source
        const importsFromSwizHook = content.includes('from "../src/SwizHook.ts"')
        const importsFromHookUtils = content.includes('from "../src/utils/hook-utils.ts"')

        if (!importsFromSwizHook && !importsFromHookUtils) {
          violations.push(
            `${name}: has denial calls but does not import from SwizHook.ts or hook-utils.ts`
          )
        }
      }

      expect(violations).toEqual([])
    })
  })

  describe("Stop hooks use canonical block helpers", () => {
    const hooks = readHookFiles(/^stop-/)

    it("no stop hook writes raw JSON to stdout for blocks", () => {
      const violations: string[] = []

      for (const { name, content } of hooks) {
        if (EXEMPTIONS[name]) continue

        const hasRawBlock = /console\.log\s*\(\s*JSON\.stringify\s*\([^)]*decision.*block/.test(
          content
        )

        if (hasRawBlock) {
          violations.push(`${name}: uses raw JSON.stringify for block instead of blockStop()`)
        }
      }

      expect(violations).toEqual([])
    })

    it("every stop hook with a block imports from hook-utils", () => {
      const violations: string[] = []

      for (const { name, content } of hooks) {
        if (EXEMPTIONS[name]) continue

        const hasBlock =
          content.includes("blockStop(") ||
          content.includes("blockStopRaw(") ||
          content.includes("blockStopObj(") ||
          content.includes("blockStopHumanRequired(")

        if (!hasBlock) continue

        const importsFromHookUtils = content.includes('from "../src/utils/hook-utils.ts"')

        if (!importsFromHookUtils) {
          violations.push(`${name}: has block calls but does not import from hook-utils.ts`)
        }
      }

      expect(violations).toEqual([])
    })
  })

  describe("formatActionPlan usage in multi-step remediation", () => {
    const pretoolHooks = readHookFiles(/^pretooluse-/)
    const stopHooks = readHookFiles(/^stop-/)

    it("hooks importing formatActionPlan actually use it", () => {
      const violations: string[] = []
      const allHooks = [...pretoolHooks, ...stopHooks]

      for (const { name, content } of allHooks) {
        const importsFormatActionPlan = content.includes("formatActionPlan")
        if (!importsFormatActionPlan) continue

        // Check if it's only in an import line but never called
        const importLine = /import\s*\{[^}]*formatActionPlan[^}]*\}/.test(content)
        const callSite = /formatActionPlan\s*\(/.test(content)

        if (importLine && !callSite) {
          violations.push(`${name}: imports formatActionPlan but never calls it`)
        }
      }

      expect(violations).toEqual([])
    })
  })
})

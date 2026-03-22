import { describe, expect, test } from "bun:test"
import { findLazyPattern } from "./offensive-language-patterns.ts"

describe("offensive-language-patterns", () => {
  describe("findLazyPattern — dismissal extensions", () => {
    test("matches pre-existing … issues (plural) before other dismissals in same sentence", () => {
      const text =
        "Both typecheck failures are pre-existing infrastructure issues (unmodified files) — not caused by my change."
      const m = findLazyPattern(text)
      expect(m).not.toBeNull()
      expect(m?.category).toBe("dismissal")
      expect(m?.response).toMatch(/pre-existing issue/i)
    })

    test("matches parenthetical (untouched)", () => {
      const m = findLazyPattern(
        "The QueueEnum export error is in manualPruneTaskQueues.ts (untouched)."
      )
      expect(m).not.toBeNull()
      expect(m?.category).toBe("dismissal")
      expect(m?.response).toMatch(/untouched/i)
    })

    test("matches parenthetical (unmodified files)", () => {
      const m = findLazyPattern("Failures only touch legacy modules (unmodified files).")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("dismissal")
      expect(m?.response).toMatch(/unmodified/i)
    })

    test("matches OOM framed as known memory limitation with tsc", () => {
      const m = findLazyPattern(
        "The OOM crash in tsc is a known memory limitation, not a code defect."
      )
      expect(m).not.toBeNull()
      expect(m?.category).toBe("dismissal")
      expect(m?.response).toMatch(/OOM|memory/i)
    })
  })

  describe("findLazyPattern — validation evidence (buying time)", () => {
    test("matches get validation evidence", () => {
      const m = findLazyPattern("Let me run lint and the test suite to get validation evidence.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("buying_time")
    })

    test("matches gather validation evidence", () => {
      const m = findLazyPattern("I'll gather validation evidence from CI logs first.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("buying_time")
    })
  })

  describe("findLazyPattern — non-matches", () => {
    test("returns null for straightforward fix commitment", () => {
      expect(
        findLazyPattern("I'll open src/api.ts and fix the TS2322 error the typecheck reported.")
      ).toBeNull()
    })
  })
})

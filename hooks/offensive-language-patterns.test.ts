import { describe, expect, test } from "bun:test"
import { findAllLazyPatterns, findLazyPattern } from "./offensive-language-patterns.ts"

describe("offensive-language-patterns", () => {
  // ── Hedging ────────────────────────────────────────────────────────────────
  describe("hedging", () => {
    test("matches 'would you like me to'", () => {
      const m = findLazyPattern("Would you like me to fix that?")
      expect(m?.category).toBe("hedging")
    })
    test("matches 'shall I proceed'", () => {
      const m = findLazyPattern("Shall I proceed with the implementation?")
      expect(m?.category).toBe("hedging")
    })
    test("matches 'I'm happy to'", () => {
      const m = findLazyPattern("I'm happy to make that change for you.")
      expect(m?.category).toBe("hedging")
    })
  })

  // ── Dismissal ──────────────────────────────────────────────────────────────
  describe("dismissal", () => {
    test("matches pre-existing issues (plural)", () => {
      const m = findLazyPattern(
        "Both typecheck failures are pre-existing infrastructure issues (unmodified files) — not caused by my change."
      )
      expect(m?.category).toBe("dismissal")
    })
    test("matches parenthetical (untouched)", () => {
      const m = findLazyPattern("The export error is in legacy.ts (untouched).")
      expect(m?.category).toBe("dismissal")
    })
    test("matches parenthetical (unmodified files)", () => {
      const m = findLazyPattern("Failures only touch legacy modules (unmodified files).")
      expect(m?.category).toBe("dismissal")
    })
    test("matches OOM framed as known memory limitation", () => {
      const m = findLazyPattern("The OOM crash in tsc is a known memory limitation.")
      expect(m?.category).toBe("dismissal")
    })
    test("matches 'can be safely ignored'", () => {
      const m = findLazyPattern("These warnings can be safely ignored.")
      expect(m?.category).toBe("dismissal")
    })
    test("matches 'that diagnostic is pre-existing'", () => {
      const m = findLazyPattern(
        "That diagnostic (line 104) is pre-existing — the sortedPlants[i] destructuring."
      )
      expect(m?.category).toBe("dismissal")
    })
    test("matches pre-existing unstaged changes (formatter/lint excuse)", () => {
      const m = findLazyPattern(
        "Biome is complaining about eslint.config.mjs formatting — that's one of the pre-existing unstaged changes. I need to format it first or exclude it from my commit. Let me run biome format on it"
      )
      expect(m?.category).toBe("dismissal")
    })
  })

  // ── Compliance gaming ──────────────────────────────────────────────────────
  describe("gaming", () => {
    test("matches 'escape hatch'", () => {
      const m = findLazyPattern("There might be an escape hatch for this requirement.")
      expect(m?.category).toBe("gaming")
    })
    test("matches 'bypass the hook'", () => {
      const m = findLazyPattern("We could bypass the check with a flag.")
      expect(m?.category).toBe("gaming")
    })
    test("matches 'the hook is too strict'", () => {
      const m = findLazyPattern("The hook is too strict for this case.")
      expect(m?.category).toBe("gaming")
    })
  })

  // ── Reframing ──────────────────────────────────────────────────────────────
  describe("reframing", () => {
    test("matches 'the hook is misunderstanding'", () => {
      const m = findLazyPattern("I believe the hook is misunderstanding the context here.")
      expect(m?.category).toBe("reframing")
    })
    test("matches 'already compliant'", () => {
      const m = findLazyPattern("I'm essentially complying with the requirement already.")
      expect(m?.category).toBe("reframing")
    })
  })

  // ── Helplessness ───────────────────────────────────────────────────────────
  describe("helplessness", () => {
    test("matches 'I'm stuck'", () => {
      const m = findLazyPattern("I'm stuck and unable to proceed with this task.")
      expect(m?.category).toBe("helplessness")
    })
    test("matches 'it seems impossible'", () => {
      const m = findLazyPattern("It seems impossible to satisfy this requirement.")
      expect(m?.category).toBe("helplessness")
    })
  })

  // ── Foot-dragging ──────────────────────────────────────────────────────────
  describe("foot_dragging", () => {
    test("matches 'I'll get to that later'", () => {
      const m = findLazyPattern("I'll get to that later, after I finish the current work.")
      expect(m?.category).toBe("foot_dragging")
    })
    test("matches 'handle that later'", () => {
      const m = findLazyPattern("I'll come back to that afterward, once the main work is done.")
      expect(m?.category).toBe("foot_dragging")
    })
  })

  // ── Minimization ───────────────────────────────────────────────────────────
  describe("minimization", () => {
    test("matches 'minor technicality'", () => {
      const m = findLazyPattern("This is just a minor technicality.")
      expect(m?.category).toBe("minimization")
    })
    test("matches 'doesn't really matter'", () => {
      const m = findLazyPattern("It doesn't really matter in this context.")
      expect(m?.category).toBe("minimization")
    })
  })

  // ── Coalition-building ─────────────────────────────────────────────────────
  describe("coalition", () => {
    test("matches 'the user would prefer' skipping enforcement", () => {
      const m = findLazyPattern("The user would prefer us to skip this enforcement.")
      expect(m?.category).toBe("coalition")
    })
    test("matches 'you should adjust the hook'", () => {
      const m = findLazyPattern("You might want to adjust this hook to be less strict.")
      expect(m?.category).toBe("coalition")
    })
  })

  // ── Scope limitation ───────────────────────────────────────────────────────
  describe("scope_limitation", () => {
    test("matches 'outside my scope'", () => {
      const m = findLazyPattern("That's outside my scope of responsibility.")
      expect(m?.category).toBe("scope_limitation")
    })
    test("matches 'a separate concern'", () => {
      const m = findLazyPattern("That's a separate concern from what I'm working on.")
      expect(m?.category).toBe("scope_limitation")
    })
  })

  // ── Performative compliance ────────────────────────────────────────────────
  describe("performative", () => {
    test("matches 'I understand, but'", () => {
      const m = findLazyPattern("I understand the concern, but I think we should move on.")
      expect(m?.category).toBe("performative")
    })
    test("matches 'going forward, I will'", () => {
      const m = findLazyPattern("Going forward, I will make sure to follow that pattern.")
      expect(m?.category).toBe("performative")
    })
  })

  // ── Buying time ────────────────────────────────────────────────────────────
  describe("buying_time", () => {
    test("matches 'get validation evidence'", () => {
      const m = findLazyPattern("Let me run lint to get validation evidence.")
      expect(m?.category).toBe("buying_time")
    })
    test("matches 'gather more information'", () => {
      const m = findLazyPattern("I need to gather more information before I can act.")
      expect(m?.category).toBe("buying_time")
    })
    test("matches 'this is a complex task'", () => {
      const m = findLazyPattern("This is a complex task that requires careful planning.")
      expect(m?.category).toBe("buying_time")
    })
  })

  // ── Trailing deferral ──────────────────────────────────────────────────────
  // Trailing deferral patterns overlap with hedging (both match "shall I", "want me to").
  // Use findAllLazyPatterns to verify trailing_deferral is detected alongside hedging.
  describe("trailing_deferral", () => {
    test("detects trailing 'want me to fix that?' alongside hedging", () => {
      const matches = findAllLazyPatterns("I found the bug in auth.ts.\nWant me to fix that?")
      const categories = matches.map((m) => m.category)
      expect(categories).toContain("trailing_deferral")
    })
    test("detects trailing 'I await your feedback'", () => {
      const m = findLazyPattern("Here is the analysis of the failing test.\nI await your feedback.")
      expect(m?.category).toBe("trailing_deferral")
    })
  })

  // ── Premature completion ───────────────────────────────────────────────────
  describe("premature_completion", () => {
    test("matches 'what's next?'", () => {
      const m = findLazyPattern("Got it. What's next?")
      expect(m?.category).toBe("premature_completion")
    })
    test("matches deferring to next session", () => {
      const m = findLazyPattern("I'll implement that in the next session.")
      expect(m?.category).toBe("premature_completion")
    })
  })

  // ── Task cancellation ──────────────────────────────────────────────────────
  describe("task_cancellation", () => {
    test("matches 'tasks created speculatively'", () => {
      const m = findLazyPattern("These tasks were created speculatively during compression.")
      expect(m?.category).toBe("task_cancellation")
    })
    test("matches 'user request is a future feature'", () => {
      const m = findLazyPattern(
        "The user's request about async hooks is a future feature, not current-session work."
      )
      expect(m?.category).toBe("task_cancellation")
    })
    test("matches 'cancel task since user hasn't specified'", () => {
      const m = findLazyPattern(
        "Let me cancel this task since the user hasn't specified the approach."
      )
      expect(m?.category).toBe("task_cancellation")
    })
  })

  // ── Adversarial: crafty evasion phrases an agent might try ──────────────
  describe("adversarial evasion attempts", () => {
    // Soft deferral disguised as politeness
    test("catches 'if you'd prefer I can' conditional offer", () => {
      const m = findLazyPattern("If you'd prefer, I can implement the caching layer now.")
      expect(m).not.toBeNull()
    })

    // Blame-shifting to the environment
    test("catches 'not caused by our changes'", () => {
      const m = findLazyPattern(
        "The lint failures are not caused by our changes — they exist in the base branch."
      )
      expect(m).not.toBeNull()
      expect(m?.category).toBe("dismissal")
    })

    // Disguising inaction as thoroughness
    test("catches 'before I can proceed I need to understand'", () => {
      const m = findLazyPattern(
        "Before I can proceed, I need to understand the full architecture of the auth module."
      )
      expect(m).not.toBeNull()
      expect(m?.category).toBe("buying_time")
    })

    // Pretending constraints prevent action
    test("catches 'cannot fix due to scope'", () => {
      const m = findLazyPattern("I can't fix this — it's outside my scope of responsibility.")
      expect(m).not.toBeNull()
    })

    // Flattery-then-deflection
    test("catches 'you're absolutely right, but let me'", () => {
      const m = findLazyPattern(
        "You're absolutely right, but let me first gather context from the other modules."
      )
      expect(m).not.toBeNull()
    })

    // Declaring victory prematurely then deferring
    test("catches 'that's everything for now'", () => {
      const m = findLazyPattern("That's everything for now. What's next?")
      expect(m).not.toBeNull()
    })

    // Reframing the hook as confused
    test("catches 'the check doesn't account for this situation'", () => {
      const m = findLazyPattern(
        "The hook doesn't account for this particular situation — it's a special case."
      )
      expect(m).not.toBeNull()
      expect(m?.category).toBe("reframing")
    })

    // Masking procrastination as quality
    test("catches 'I want to deliver a polished result'", () => {
      const m = findLazyPattern(
        "I'd rather deliver a comprehensive and well-thought-out implementation."
      )
      expect(m).not.toBeNull()
      expect(m?.category).toBe("buying_time")
    })

    // Recruiting the user against the hook
    test("catches 'this hook is slowing us down'", () => {
      const m = findLazyPattern("This check is slowing progress down significantly.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("coalition")
    })

    // Inventing an approval chain
    test("catches 'we should check with someone first'", () => {
      const m = findLazyPattern(
        "It might be worth checking this approach with the team before proceeding."
      )
      expect(m).not.toBeNull()
      expect(m?.category).toBe("buying_time")
    })

    // Scope-narrowing to dodge work
    test("catches 'that should be handled in a separate effort'", () => {
      const m = findLazyPattern("That should be handled in a separate dedicated effort.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("scope_limitation")
    })

    // Promising future compliance
    test("catches 'from now on I will follow that pattern'", () => {
      const m = findLazyPattern("From now on, I will make sure to validate inputs first.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("performative")
    })

    // Labeling work as optional
    test("catches 'not a big deal'", () => {
      const m = findLazyPattern("It's not a big deal — the tests still pass.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("minimization")
    })

    // Self-victimization
    test("catches 'I keep getting blocked'", () => {
      const m = findLazyPattern("I keep getting the same block over and over.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("helplessness")
    })

    // Cancellation disguised as rationalization
    test("catches task cancellation with 'no longer needed'", () => {
      const m = findLazyPattern(
        "Let me cancel this task since it's no longer needed given the new approach."
      )
      expect(m).not.toBeNull()
      expect(m?.category).toBe("task_cancellation")
    })

    // Declaring the hook is in a loop
    test("catches 'the hook is stuck in a loop'", () => {
      const m = findLazyPattern("The stop hook is stuck in an infinite loop.")
      expect(m).not.toBeNull()
    })

    // Subtle session-ending signal
    test("catches 'we're good here'", () => {
      const m = findLazyPattern("I think we're good here for this session.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("premature_completion")
    })

    // Disguising delay as decomposition
    test("catches 'let me break this into smaller pieces'", () => {
      const m = findLazyPattern("Maybe we should break this into smaller manageable tasks first.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("buying_time")
    })

    // Fabricated external dependency
    test("catches 'we're waiting on the build result'", () => {
      const m = findLazyPattern("We're still waiting on the CI build result before we can proceed.")
      expect(m).not.toBeNull()
      expect(m?.category).toBe("buying_time")
    })
  })

  // ── Non-matches ────────────────────────────────────────────────────────────
  describe("non-matches", () => {
    test("returns null for straightforward fix commitment", () => {
      expect(
        findLazyPattern("I'll open src/api.ts and fix the TS2322 error the typecheck reported.")
      ).toBeNull()
    })
    test("returns null for direct action statement", () => {
      expect(findLazyPattern("Adding the missing import for UserService.")).toBeNull()
    })
    test("returns null for factual status report", () => {
      expect(findLazyPattern("All 47 tests pass. Typecheck clean.")).toBeNull()
    })
  })

  // ── findAllLazyPatterns deduplication ───────────────────────────────────────
  describe("findAllLazyPatterns", () => {
    test("deduplicates by category", () => {
      const text =
        "Would you like me to fix that? Do you want me to proceed? " +
        "These warnings can be safely ignored."
      const matches = findAllLazyPatterns(text)
      const categories = matches.map((m) => m.category)
      // hedging should appear once (deduped), dismissal once
      expect(new Set(categories).size).toBe(categories.length)
      expect(categories).toContain("hedging")
      expect(categories).toContain("dismissal")
    })
  })
})

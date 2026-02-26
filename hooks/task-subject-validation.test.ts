import { describe, test, expect } from "bun:test";
import { detect, formatMessage, type CompoundMatch } from "./task-subject-validation.ts";

describe("detect", () => {
  describe("no match (single concern)", () => {
    test("plain imperative subject", () => {
      expect(detect("Fix authentication bug").matched).toBe(false);
    });

    test("short subject", () => {
      expect(detect("Add CI").matched).toBe(false);
    });

    test("update with single object", () => {
      expect(detect("Update README").matched).toBe(false);
    });

    test("and in non-action context is not compound", () => {
      // "merge" is not in ACTION_VERBS so second part is not an independent action
      expect(detect("Review and merge the PR").matched).toBe(false);
    });

    test("single issue hash is not compound", () => {
      expect(detect("Fix #123").matched).toBe(false);
    });
  });

  describe("multiple issue hashes", () => {
    test("two hashes are split", () => {
      const result = detect("Fix #123 and #456");
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      expect(result.suggestions).toHaveLength(2);
      expect(result.suggestions[0]).toContain("#123");
      expect(result.suggestions[1]).toContain("#456");
    });

    test("three hashes are split", () => {
      const result = detect("Address #10, #20, and #30");
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      expect(result.suggestions).toHaveLength(3);
    });
  });

  describe("comma-separated list (3+ items)", () => {
    test("three-item list is matched", () => {
      const result = detect("Fix the login, register, and logout flows");
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
    });

    test("shared trailing object: verb appended to each part", () => {
      const result = detect("Review, approve, and merge the PR");
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      // Each suggestion should reference the shared object "the PR"
      for (const s of result.suggestions) {
        expect(s.toLowerCase()).toContain("pr");
      }
    });

    test("suffix expansion: date list gets full context", () => {
      const result = detect("Get usage breakdowns from billing console for Dec 2025, Jan 2026, Feb 2026");
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      expect(result.suggestions).toHaveLength(3);
      expect(result.suggestions[0]).toContain("Dec 2025");
      expect(result.suggestions[1]).toContain("Jan 2026");
      expect(result.suggestions[2]).toContain("Feb 2026");
    });
  });

  describe("and-separated compound with two action verbs", () => {
    test("two independent action verbs are split", () => {
      const result = detect("Add feature and fix bug");
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      expect(result.suggestions).toHaveLength(2);
    });

    test("verb is prepended to each suggestion", () => {
      const result = detect("Add feature and fix bug");
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      // "Add feature" and "Fix bug" should appear
      expect(result.suggestions.some((s) => /feature/i.test(s))).toBe(true);
      expect(result.suggestions.some((s) => /fix/i.test(s))).toBe(true);
    });

    test("non-action second part is not compound", () => {
      // "verify" is excluded from ACTION_VERBS intentionally
      expect(detect("Add feature and verify it works").matched).toBe(false);
    });
  });
});

describe("formatMessage", () => {
  test("formats intro and bullet list", () => {
    const match: CompoundMatch = {
      matched: true,
      intro: "This is a compound task. Suggested split:",
      suggestions: ["Fix login bug", "Fix logout bug"],
    };
    const msg = formatMessage(match);
    expect(msg).toContain("compound task");
    expect(msg).toContain("• Fix login bug");
    expect(msg).toContain("• Fix logout bug");
  });

  test("appends optional postfix", () => {
    const match: CompoundMatch = {
      matched: true,
      intro: "Split:",
      suggestions: ["Task A", "Task B"],
    };
    const msg = formatMessage(match, "Please create separate tasks.");
    expect(msg).toContain("Please create separate tasks.");
  });
});

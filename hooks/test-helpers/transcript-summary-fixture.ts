// Shared test fixture: builds a minimal TranscriptSummary-shaped object from a
// list of raw session lines. Used by skill-recency gate tests that inject
// `_transcriptSummary.sessionLines` to exercise the real recency path without
// spawning a hook subprocess. Centralized here so identical copies don't get
// flagged by the resect `similar` pre-commit check.

export function summaryFromLines(sessionLines: string[]): Record<string, unknown> {
  return {
    toolNames: [],
    toolCallCount: 0,
    bashCommands: [],
    skillInvocations: [],
    hasGitPush: false,
    sessionLines,
    sessionDurationMs: 0,
    successfulTestRuns: 0,
    lastVerificationTime: null,
    sessionScope: "trivial",
  }
}

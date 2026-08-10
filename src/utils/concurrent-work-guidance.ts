/** Calm, action-oriented guidance for repositories shared by multiple sessions. */
export const CONCURRENT_WORK_REASSURANCE = [
  "Concurrent changes in a shared directory are normal.",
  "Don't panic.",
  "Continue as you were.",
  "Stay focused on your own task.",
  "It's going to be fine.",
].join(" ")

export const CONCURRENT_WORK_BOUNDARY = [
  "Leave unrelated changes exactly as you found them.",
  "Do not stash, revert, restore, reset, clean, delete, overwrite, stage, or commit another session's work.",
  "Only inspect or edit one of these files when your task genuinely needs that exact file.",
].join(" ")

export function buildConcurrentWorkGuidance(): string {
  return `${CONCURRENT_WORK_REASSURANCE}\n${CONCURRENT_WORK_BOUNDARY}`
}

export function buildConcurrentWaitGuidance(operation: string): string {
  return [
    `ℹ ${operation}`,
    buildConcurrentWorkGuidance(),
    "Changes that appear in the shared directory while this command runs are not, by themselves, a failure or conflict.",
  ].join("\n")
}

export function containsConcurrentWorkGuidance(text: string): boolean {
  return text.includes(CONCURRENT_WORK_REASSURANCE)
}

export function buildConcurrentFileEditGuidance(
  displayPath: string,
  ageDescription: string
): string {
  return [
    CONCURRENT_WORK_REASSURANCE,
    `Another agent touched ${displayPath} ${ageDescription} ago. This exact-file overlap needs one calm check, not a change of plan.`,
    `Re-read ${displayPath} immediately before editing, preserve the changes already there, and apply only your task-scoped change.`,
    "Do not stash, revert, restore, reset, clean, delete, or overwrite the other session's work. If the edits do not conflict, continue normally. If they do conflict, integrate both intents instead of discarding either one.",
  ].join("\n")
}

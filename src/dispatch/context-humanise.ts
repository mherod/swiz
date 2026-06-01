export function shouldHumaniseContextOutput({
  canonicalEvent,
  humaniseEnabled,
  withinGrace,
}: {
  canonicalEvent: string
  humaniseEnabled: boolean
  withinGrace: boolean
}): boolean {
  if (!humaniseEnabled || withinGrace) return false

  // UserPromptSubmit runs alongside the user's actual prompt. Keep this context
  // mechanical so a rewrite cannot turn neutral state into conflicting guidance.
  return canonicalEvent !== "userPromptSubmit"
}

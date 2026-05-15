import { rephraseHookMessage } from "../hook-message-rephrasing.ts"

export function replaceTaskGovernanceSynonyms(text: string, randomSource?: () => number): string {
  return rephraseHookMessage(text, randomSource)
}

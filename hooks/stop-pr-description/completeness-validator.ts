/**
 * PR description completeness validator.
 *
 * Checks if PR body meets minimum content requirements.
 */

const MIN_CHAR_COUNT = 20

export function isEmptyDescription(body: string): boolean {
  return body.replace(/\s/g, "").length === 0
}

export function isTooShortDescription(body: string): boolean {
  return body.replace(/\s/g, "").length < MIN_CHAR_COUNT
}

export function getCharCount(body: string): number {
  return body.replace(/\s/g, "").length
}

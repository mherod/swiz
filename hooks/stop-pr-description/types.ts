/**
 * PR description validation types.
 *
 * Domain types for PR body format and completeness validation.
 */

export interface PRCheckContext {
  cwd: string
  prNumber: number
  prTitle: string
  prBody: string
}

export interface PRValidationState {
  isEmpty: boolean
  hasPlaceholder: boolean
  isTooShort: boolean
  minCharCount: number
}

export interface PRValidationResult {
  isValid: boolean
  violation: string | null
}

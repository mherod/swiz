/** A command-owned value flag; aliases share validation and assignment. */
export interface ValueOption<State> {
  names: string[]
  missingMessage: string
  apply: (state: State, value: string, flag: string) => void
}

/**
 * Apply a recognized value option, returning whether the caller should consume it.
 * Example: if (applyValueOption(VALUE_OPTIONS, arg, args[i + 1], state)) i++
 */
export function applyValueOption<State>(
  options: readonly ValueOption<State>[],
  arg: string,
  next: string | undefined,
  state: State
): boolean {
  const option = options.find((entry) => entry.names.includes(arg))
  if (!option) return false
  if (!next) throw new Error(option.missingMessage)
  option.apply(state, next, arg)
  return true
}

/** Preserve decimal-prefix parsing, e.g. parsePositiveInt("10ms", "--timeout"). */
export function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got: ${value}`)
  }
  return parsed
}

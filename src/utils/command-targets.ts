const REDIRECTIONS = new Set(["1>", "2>", ">", ">>", "<", "2>&1", "2>>", "&>", "1>>"])
const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "&"])

/**
 * Collect positional targets from tokenized runner arguments, skipping flag values.
 * For example, ["eslint", "--format", "json", "."] yields ["."] with startIndex 1
 * and flagsWithValues containing "--format". Runner recognition stays with the caller.
 */
export function collectTargets(
  tokens: readonly string[],
  startIndex: number,
  flagsWithValues: ReadonlySet<string>
): string[] {
  const targets: string[] = []
  let inDoubleDash = false

  for (let index = startIndex; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === "--") {
      inDoubleDash = true
    } else if (!inDoubleDash && token.startsWith("-")) {
      const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token
      if (!token.includes("=") && flagsWithValues.has(name)) index++
    } else if (REDIRECTIONS.has(token)) {
      index++
    } else if (SHELL_OPERATORS.has(token)) {
      break
    } else {
      targets.push(token)
    }
  }

  return targets
}

/**
 * PR description format validator.
 *
 * Checks for placeholder patterns and template text in PR body.
 */

const PLACEHOLDER_PATTERNS = [
  "Describe your changes",
  "What does this PR do",
  "<!-- ",
  "Add a description",
  "[Add description]",
  "Your description here",
]

export function hasSummaryPlaceholder(body: string): boolean {
  const lines = body.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (/^## Summary/.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j]
        if (!nextLine || nextLine.trim() === "") continue
        return nextLine.trim().startsWith("<")
      }
    }
  }
  return false
}

export function hasPlaceholderPattern(body: string): boolean {
  const bodyLower = body.toLowerCase()
  return PLACEHOLDER_PATTERNS.some((p) => bodyLower.includes(p.toLowerCase()))
}

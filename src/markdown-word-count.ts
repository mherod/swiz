/**
 * Count markdown words while ignoring code blocks and markdown syntax noise.
 */
export function countMarkdownWords(text: string): number {
  // Remove YAML frontmatter with BOM and line-ending variants
  let processed = text.replace(/^\uFEFF?---+[\r\n]+[\s\S]*?[\r\n]+---+[\r\n]+/, "")

  // Strip fenced code blocks (```...```)
  processed = processed.replace(/```[\s\S]*?```/g, "")

  // Remove indented code blocks
  processed = processed.replace(/(?:^(?: {4}|\t).*\n?)+/gm, "")

  // Strip HTML comments
  processed = processed.replace(/<!--[\s\S]*?-->/g, "")

  // Remove markdown heading syntax
  processed = processed.replace(/^#+\s/gm, "")

  // Remove markdown emphasis markers
  processed = processed.replace(/[*_`]/g, "")

  // Remove markdown list markers
  processed = processed.replace(/^[\s]*[-*+]\s+/gm, "")

  // Remove blockquote markers
  processed = processed.replace(/^>\s+/gm, "")

  // Remove markdown link syntax [text](url) -> text
  processed = processed.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")

  // Remove markdown image syntax
  processed = processed.replace(/!\[[^\]]*\]\([^)]+\)/g, "")

  // Remove inline HTML tags
  processed = processed.replace(/<[^>]+>/g, "")

  // Remove markdown horizontal rules
  processed = processed.replace(/^[\s]*(?:---|===|\*\*\*|___)/gm, "")

  // Normalize whitespace and count words
  processed = processed.trim().replace(/\s+/g, " ")
  return processed.split(/\s+/).filter((word) => word.length > 0).length
}

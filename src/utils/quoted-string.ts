/**
 * Utilities for parsing and handling quoted strings.
 * Consolidates quote handling logic used across skill parsing and validation.
 */

/**
 * Parse a possibly-quoted string into its quote character and content.
 * Handles both single and double quotes.
 *
 * @param raw - The raw string, possibly surrounded by quotes
 * @returns Object with quoteChar ('"', "'", or "") and the unquoted content
 *
 * @example
 * parseQuotedString('  "hello"  ') // { quoteChar: '"', content: 'hello' }
 * parseQuotedString("'world'") // { quoteChar: "'", content: 'world' }
 * parseQuotedString('unquoted') // { quoteChar: "", content: 'unquoted' }
 */
export function parseQuotedString(raw: string): { quoteChar: string; content: string } {
  const trimmed = raw.trim()
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  const quoteChar = quoted ? trimmed[0]! : ""
  const content = quoted ? trimmed.slice(1, -1) : trimmed
  return { quoteChar, content }
}

/**
 * Remove leading and trailing quotes from a string.
 *
 * @param raw - The raw string, possibly surrounded by quotes
 * @returns The unquoted string
 *
 * @example
 * stripQuotes('  "hello"  ') // 'hello'
 * stripQuotes("'world'") // 'world'
 * stripQuotes('unquoted') // 'unquoted'
 */
export function stripQuotes(raw: string): string {
  const { content } = parseQuotedString(raw)
  return content
}

/**
 * Re-apply quotes to a string using the original quote character.
 *
 * @param content - The unquoted content
 * @param quoteChar - The quote character ('"', "'", or "")
 * @returns The re-quoted string, or unquoted if quoteChar is ""
 *
 * @example
 * requoteString('hello', '"') // '"hello"'
 * requoteString('world', "'") // "'world'"
 * requoteString('unquoted', '') // 'unquoted'
 */
export function requoteString(content: string, quoteChar: string): string {
  return quoteChar ? `${quoteChar}${content}${quoteChar}` : content
}

/**
 * Transform a quoted string, preserving its quote style.
 *
 * @param raw - The raw string, possibly quoted
 * @param transform - Function to transform the unquoted content
 * @returns Object with the transformed result and unmapped field (if transform had no effect)
 *
 * @example
 * transformQuotedString('"hello"', (s) => s.toUpperCase())
 * // { result: '"HELLO"', unmapped: undefined }
 *
 * transformQuotedString("'name'", (s) => s)
 * // { result: "'name'", unmapped: 'name' }
 */
export function transformQuotedString(
  raw: string,
  transform: (content: string) => string
): { result: string; unmapped?: string } {
  const { quoteChar, content } = parseQuotedString(raw)
  const transformed = transform(content)
  return {
    result: requoteString(transformed, quoteChar),
    unmapped: transformed === content ? content : undefined,
  }
}

/**
 * File word/line/char counting utilities.
 * Extracted from hooks/hook-utils.ts so src/commands can import without
 * crossing the src → hooks dependency boundary.
 */

/**
 * Count words in a file, handling edge cases like BOM, CRLF, Unicode, binary files.
 * Returns null if file is binary, doesn't exist, or can't be read.
 * Returns { words, lines, chars } for text files.
 */
export async function countFileWords(
  path: string
): Promise<{ words: number; lines: number; chars: number } | null> {
  try {
    // Check if file exists using statSync
    const { statSync } = await import("node:fs")
    try {
      statSync(path)
    } catch {
      return null // File doesn't exist
    }

    const file = Bun.file(path)
    const size = file.size

    // Empty file edge case
    if (size === 0) {
      return { words: 0, lines: 0, chars: 0 }
    }

    // Guard against binary files: check first 512 bytes for null bytes
    const headerBuffer = await file.slice(0, 512).arrayBuffer()
    const headerView = new Uint8Array(headerBuffer)
    if (headerView.includes(0)) return null // Binary file detected

    // Read and parse file for stats
    const content = await file.text()
    const chars = content.length

    // Count lines (handle CRLF and LF)
    let lines = 0
    let words = 0
    let inWord = false

    for (let i = 0; i < content.length; i++) {
      const char = content.charAt(i)

      // Line counting: count newlines, add 1 if content doesn't end with newline
      if (char === "\n") {
        lines++
      }

      // Word counting: track whitespace boundaries
      const isWhitespace = /\s/.test(char)
      if (!isWhitespace && !inWord) {
        words++
        inWord = true
      } else if (isWhitespace) {
        inWord = false
      }
    }

    // If file doesn't end with newline, add 1 to line count
    if (content.length > 0 && content[content.length - 1] !== "\n") {
      lines++
    }

    return { words, lines, chars }
  } catch {
    return null
  }
}

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
async function readTextContent(path: string): Promise<string | null> {
  const { statSync } = await import("node:fs")
  try {
    statSync(path)
  } catch {
    return null
  }
  const file = Bun.file(path)
  if (file.size === 0) return ""
  const headerView = new Uint8Array(await file.slice(0, 512).arrayBuffer())
  if (headerView.includes(0)) return null
  return file.text()
}

function countContentStats(content: string): { words: number; lines: number; chars: number } {
  if (content.length === 0) return { words: 0, lines: 0, chars: 0 }
  let lines = 0
  let words = 0
  let inWord = false
  for (let i = 0; i < content.length; i++) {
    const char = content.charAt(i)
    if (char === "\n") lines++
    const isWhitespace = /\s/.test(char)
    if (!isWhitespace && !inWord) {
      words++
      inWord = true
    } else if (isWhitespace) {
      inWord = false
    }
  }
  if (content[content.length - 1] !== "\n") lines++
  return { words, lines, chars: content.length }
}

export async function countFileWords(
  path: string
): Promise<{ words: number; lines: number; chars: number } | null> {
  try {
    const content = await readTextContent(path)
    if (content === null) return null
    return countContentStats(content)
  } catch {
    return null
  }
}

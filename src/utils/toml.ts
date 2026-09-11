import type { z } from "zod"

/** Serialize JSON-compatible values for a TOML assignment. Reparse the complete document before writing. */
export function renderTomlValue(value: z.input<z.ZodUnknown>): string {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(renderTomlValue).join(", ")}]`
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{ ${Object.entries(value)
      .map(([key, val]) => `${JSON.stringify(key)} = ${renderTomlValue(val)}`)
      .join(", ")} }`
  }
  throw new Error("Unsupported value for TOML; configuration was not written")
}

function tomlTablePath(line: string): string | null {
  const trimmed = line.trim()
  const arrayTable = trimmed.match(/^\[\[(.*?)\]\]\s*(?:#.*)?$/)
  if (arrayTable) return arrayTable[1]!.trim()
  const table = trimmed.match(/^\[(.*?)\]\s*(?:#.*)?$/)
  return table ? table[1]!.trim() : null
}

function isRootTomlPath(path: string, root: string): boolean {
  return new RegExp(`^(?:${root}|"${root}"|'${root}')(?:\\s*\\.|\\s*$)`).test(path.trim())
}

function isTopLevelRootAssignment(line: string, root: string): boolean {
  return new RegExp(
    `^\\s*(?:${root}|"${root}"|'${root}')(?:\\s*\\.\\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*\\s*=`
  ).test(line)
}

function nextMultilineStringKind(
  line: string,
  current: '"""' | "'''" | null
): '"""' | "'''" | null {
  const doubleIndex = line.indexOf('"""')
  const literalIndex = line.indexOf("'''")
  let firstDelimiter: '"""' | "'''" | null = null
  if (doubleIndex >= 0 && (literalIndex < 0 || doubleIndex < literalIndex)) {
    firstDelimiter = '"""'
  } else if (literalIndex >= 0) {
    firstDelimiter = "'''"
  }
  const delimiter = current ?? firstDelimiter
  if (!delimiter) return null

  const openingIndex = current ? -delimiter.length : line.indexOf(delimiter)
  return line.indexOf(delimiter, openingIndex + delimiter.length) >= 0 ? null : delimiter
}

function assignmentEndLine(lines: string[], startLine: number, root: string): number {
  for (let lineIndex = startLine; lineIndex < lines.length; lineIndex++) {
    try {
      const parsed = Bun.TOML.parse(lines.slice(startLine, lineIndex + 1).join("\n"))
      if (Object.hasOwn(parsed, root)) return lineIndex
    } catch {
      // Keep extending the candidate until the TOML value is complete.
    }
  }
  return lines.length - 1
}

export function stripTomlRoot(text: string, root: "hooks" | "mcp_servers"): string {
  const lines = text.split("\n")
  const kept: string[] = []
  let skippingHooksTable = false
  let seenTable = false
  let multilineString: '"""' | "'''" | null = null

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const startsInMultilineString = multilineString !== null
    multilineString = nextMultilineStringKind(line, multilineString)
    const tablePath = startsInMultilineString ? null : tomlTablePath(line)
    if (tablePath !== null) {
      seenTable = true
      skippingHooksTable = isRootTomlPath(tablePath, root)
      if (!skippingHooksTable) kept.push(line)
      continue
    }
    if (skippingHooksTable) continue

    if (!seenTable && isTopLevelRootAssignment(line, root)) {
      index = assignmentEndLine(lines, index, root)
      continue
    }
    kept.push(line)
  }

  return kept.join("\n")
}

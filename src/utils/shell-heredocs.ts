type Quote = "'" | '"' | null

interface Heredoc {
  delimiter: string
  quoted: boolean
  stripTabs: boolean
  end: number
}

const WORD_BOUNDARY = /[\s;&|<>()]/

interface DelimiterState {
  quote: Quote
  quoted: boolean
  delimiter: string
}

function consumeDelimiterEscape(command: string, index: number, state: DelimiterState): number {
  const next = command[index + 1]
  if (next === "\n") return index + 1
  if (next !== undefined && (!state.quote || /[$`"\\]/.test(next))) {
    state.quoted = true
    state.delimiter += next
    return index + 1
  }
  state.delimiter += "\\"
  return index
}

function consumeDelimiterChar(command: string, index: number, state: DelimiterState): number {
  const ch = command[index]!
  if (ch === state.quote) {
    state.quote = null
  } else if (!state.quote && (ch === "'" || ch === '"')) {
    state.quote = ch
    state.quoted = true
  } else if (ch === "\\" && state.quote !== "'") {
    return consumeDelimiterEscape(command, index, state)
  } else {
    state.delimiter += ch
  }
  return index
}

function unsupportedDelimiterQuote(command: string, index: number, quote: Quote): boolean {
  return !quote && command[index] === "$" && /['"]/.test(command[index + 1] ?? "")
}

/** Read a delimiter word with shell quote removal, without expanding its contents. */
function readHeredoc(command: string, start: number): Heredoc | null {
  let end = start + 2
  const stripTabs = command[end] === "-"
  if (stripTabs) end++
  while (command[end] === " " || command[end] === "\t") end++
  const wordStart = end
  const state: DelimiterState = { quote: null, quoted: false, delimiter: "" }
  for (; end < command.length; end++) {
    const ch = command[end]!
    if (!state.quote && WORD_BOUNDARY.test(ch)) break
    /** ANSI-C and locale quote removal are outside this scanner's grammar. */
    if (unsupportedDelimiterQuote(command, end, state.quote)) return null
    end = consumeDelimiterChar(command, end, state)
  }
  if (state.quote || end === wordStart) return null
  return { delimiter: state.delimiter, quoted: state.quoted, stripTabs, end }
}

interface BodyRange {
  start: number
  end: number
  contentEnd: number
}

/** Only <<- strips tabs; quoted bodies never join backslash-newline pairs. */
function readBody(command: string, start: number, heredoc: Heredoc): BodyRange {
  let position = start
  let continued = ""
  while (position < command.length) {
    const newline = command.indexOf("\n", position)
    const lineEnd = newline < 0 ? command.length : newline
    const line = command.slice(position, lineEnd)
    const candidate = continued + (heredoc.stripTabs ? line.replace(/^\t+/, "") : line)
    const contentEnd = position
    position = newline < 0 ? command.length : newline + 1
    if (!heredoc.quoted && newline >= 0 && /(?<!\\)(?:\\\\)*\\$/.test(line)) {
      continued = candidate.slice(0, -1).slice(0, heredoc.delimiter.length + 1)
      continue
    }
    continued = ""
    if (candidate === heredoc.delimiter) return { start, end: position, contentEnd }
  }
  return { start, end: command.length, contentEnd: command.length }
}

function expansionOpening(command: string, index: number, quote: Quote): string | null {
  if (command[index] === "`") return "`"
  if (command.startsWith("${", index)) return "{"
  if (command.startsWith("$(", index)) return "("
  if (!quote && /^(?:[<>]\(|\(\()/.test(command.slice(index, index + 2))) return "("
  return null
}

function quotedCharacterEnd(
  command: string,
  index: number,
  state: { quote: Quote }
): number | null {
  const ch = command[index]!
  if (ch === "\\" && state.quote !== "'") return index + 1
  if (state.quote) {
    if (ch === state.quote) state.quote = null
    return index
  }
  if (ch === "'" || ch === '"') {
    state.quote = ch
    return index
  }
  return null
}

function backtickEnd(command: string, start: number): number {
  for (let index = start + 1; index < command.length; index++) {
    if (command[index] === "\\") index++
    else if (command[index] === "`") return index
  }
  return command.length - 1
}

/** Skip nested grammar without abandoning subsequent top-level heredoc parsing. */
function expansionEnd(command: string, start: number, opening: string): number {
  if (opening === "`") return backtickEnd(command, start)
  const closing = opening === "{" ? "}" : ")"
  let depth = 1
  const state: { quote: Quote } = { quote: null }
  for (let index = start + 2; index < command.length; index++) {
    const ch = command[index]!
    const quotedEnd = quotedCharacterEnd(command, index, state)
    if (quotedEnd !== null) {
      index = quotedEnd
    } else if (ch === opening) {
      depth++
    } else if (ch === closing && --depth === 0) {
      return index
    }
  }
  return command.length - 1
}

interface PendingHeredoc extends Heredoc {
  commandStart: number
  headerEnd?: number
}

interface Range {
  start: number
  end: number
}

interface ParsedBody extends BodyRange {
  declaration: PendingHeredoc
}

export interface ShellHeredoc {
  body: string
  offset: number
  quoted: boolean
  /** Receiving command and downstream pipeline, excluding comments and redirects. */
  header: string
}

interface ScanState {
  quote: Quote
  commandStart: number
  pending: PendingHeredoc[]
  ranges: Range[]
  bodies: ParsedBody[]
}

function advanceQuote(command: string, index: number, state: ScanState): number | null {
  const ch = command[index]!
  if (ch === "\\" && state.quote !== "'") return index + 1
  if (state.quote !== "'") {
    const opening = expansionOpening(command, index, state.quote)
    if (opening) return expansionEnd(command, index, opening)
  }
  return quotedCharacterEnd(command, index, state)
}

function finishHeaders(state: ScanState, end: number): void {
  for (const declaration of state.pending) declaration.headerEnd ??= end
}

function consumeBodies(command: string, start: number, state: ScanState): number {
  finishHeaders(state, start - 1)
  let bodyStart = start
  for (const declaration of state.pending) {
    const range = readBody(command, bodyStart, declaration)
    state.ranges.push(range)
    state.bodies.push({ ...range, declaration })
    bodyStart = range.end
  }
  state.pending.length = 0
  state.commandStart = bodyStart
  return bodyStart - 1
}

function advanceDeclaration(command: string, index: number, state: ScanState): number | null {
  if (!command.startsWith("<<", index) || command[index - 1] === "<") return null
  if (command[index + 2] === "<") return index + 2
  const heredoc = readHeredoc(command, index)
  if (!heredoc) return index + 1
  state.pending.push({ ...heredoc, commandStart: state.commandStart })
  state.ranges.push({ start: index, end: heredoc.end })
  return heredoc.end - 1
}

function advanceBoundary(command: string, index: number, state: ScanState): number {
  const ch = command[index]!
  if (ch === "\n") return consumeBodies(command, index + 1, state)
  if (ch === "&" && /[<>]/.test(command[index - 1] ?? "")) return index
  if (ch === ";" || ch === "&") finishHeaders(state, index)
  if (";|&".includes(ch)) state.commandStart = index + 1
  return index
}

function advanceSyntax(command: string, index: number, state: ScanState): number {
  if (command[index] === "#" && (index === 0 || WORD_BOUNDARY.test(command[index - 1]!))) {
    finishHeaders(state, index)
    const newline = command.indexOf("\n", index)
    return newline < 0 ? command.length : newline - 1
  }
  return advanceDeclaration(command, index, state) ?? advanceBoundary(command, index, state)
}

function maskRanges(command: string, ranges: Range[]): string {
  const chunks: string[] = []
  let copiedThrough = 0
  for (const { start, end } of ranges) {
    chunks.push(
      command.slice(copiedThrough, start),
      command.slice(start, end).replace(/[^\n]/g, " ")
    )
    copiedThrough = end
  }
  chunks.push(command.slice(copiedThrough))
  return chunks.join("")
}

/**
 * Separate heredoc input from executable shell syntax before any normalization.
 * Delimiters are recognized only in unquoted, top-level grammar. Keep bodies
 * separately so callers can inspect expansions and interpreter stdin explicitly.
 */
export function splitHeredocBodies(command: string): {
  command: string
  heredocs: ShellHeredoc[]
} {
  const state: ScanState = { quote: null, commandStart: 0, pending: [], ranges: [], bodies: [] }
  for (let index = 0; index < command.length; index++) {
    index = advanceQuote(command, index, state) ?? advanceSyntax(command, index, state)
  }
  const masked = maskRanges(command, state.ranges)
  return {
    command: masked,
    heredocs: state.bodies.map(({ start, contentEnd, declaration }) => ({
      body: command.slice(start, contentEnd),
      offset: start,
      quoted: declaration.quoted,
      header: masked.slice(declaration.commandStart, declaration.headerEnd),
    })),
  }
}

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

/** The very first body line can be the delimiter; only <<- permits leading tabs. */
function heredocEnd(command: string, start: number, heredoc: Heredoc): number {
  let position = start
  let continued = ""
  while (position < command.length) {
    const newline = command.indexOf("\n", position)
    const lineEnd = newline < 0 ? command.length : newline
    const line = command.slice(position, lineEnd)
    const candidate = continued + (heredoc.stripTabs ? line.replace(/^\t+/, "") : line)
    position = newline < 0 ? command.length : newline + 1
    if (!heredoc.quoted && newline >= 0 && /(?<!\\)(?:\\\\)*\\$/.test(line)) {
      continued = candidate.slice(0, -1).slice(0, heredoc.delimiter.length + 1)
      continue
    }
    continued = ""
    if (candidate === heredoc.delimiter) return position
  }
  return command.length
}

interface ScanState {
  quote: Quote
  pending: Heredoc[]
  chunks: string[]
  copiedThrough: number
}

function isNestedGrammar(command: string, index: number, quote: Quote): boolean {
  return (
    quote !== "'" &&
    (command[index] === "`" ||
      command.startsWith("$(", index) ||
      (!quote && command.startsWith("((", index)))
  )
}

function advanceQuote(command: string, index: number, state: ScanState): number | null {
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

function isComment(command: string, index: number): boolean {
  return command[index] === "#" && (index === 0 || WORD_BOUNDARY.test(command[index - 1]!))
}

function consumeBodies(command: string, start: number, state: ScanState): number {
  let bodyStart = start
  for (const heredoc of state.pending) {
    const end = heredocEnd(command, bodyStart, heredoc)
    if (heredoc.quoted) {
      state.chunks.push(command.slice(state.copiedThrough, bodyStart))
      state.copiedThrough = end
    }
    bodyStart = end
  }
  state.pending.length = 0
  return bodyStart - 1
}

function advanceSyntax(command: string, index: number, state: ScanState): number | null {
  if (isComment(command, index)) {
    const newline = command.indexOf("\n", index)
    return newline < 0 ? command.length : newline - 1
  }
  if (command.startsWith("<<", index) && command[index - 1] !== "<") {
    if (command[index + 2] === "<") return index + 2
    const heredoc = readHeredoc(command, index)
    if (!heredoc) return null
    state.pending.push(heredoc)
    return heredoc.end - 1
  }
  if (command[index] === "\n" && state.pending.length > 0) {
    return consumeBodies(command, index + 1, state)
  }
  return index
}

/**
 * Remove only literal heredoc bodies. Scan shell quoting before recognizing <<,
 * then consume queued bodies in declaration order without interpreting their text.
 * Unquoted bodies remain intact because command substitutions can execute there.
 */
export function stripQuotedHeredocs(command: string): string {
  const state: ScanState = { quote: null, pending: [], chunks: [], copiedThrough: 0 }
  for (let index = 0; index < command.length; index++) {
    /** Nested shell and arithmetic grammars need their own parser. Keep all text
     * for the existing invocation detector rather than risk masking executable code. */
    if (isNestedGrammar(command, index, state.quote)) return command
    const end = advanceQuote(command, index, state) ?? advanceSyntax(command, index, state)
    if (end === null) return command
    index = end
  }
  state.chunks.push(command.slice(state.copiedThrough))
  return state.chunks.join("")
}

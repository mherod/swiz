import { EventEmitter } from "node:events"

export interface DisplayTurn {
  role: "user" | "assistant"
  timestamp?: string
  /** Plain text content for user turns */
  text?: string
  /** Structured blocks for assistant turns */
  blocks?: Array<{
    type: "text" | "tool_use" | "tool_result"
    text?: string
    toolLabel?: string
    isError?: boolean
  }>
  /** Debug events interleaved before this turn */
  debugLines?: Array<{ time: string; text: string }>
}

export interface MonitorState {
  phase: string
  /** "display" for standard rendering, "auto-reply" for LLM generation */
  mode: "display" | "auto-reply" | "list"
  /** Session ID being displayed */
  sessionId: string
  /** Turns to render in display mode */
  turns: DisplayTurn[]
  /** Total turns loaded */
  totalTurns: number
  /** Trailing debug lines (after all turns) */
  trailingDebug: Array<{ time: string; text: string }>
  /** Auto-reply: which LLM generation pass (1 = flipped, 2 = normal) */
  currentPass: number
  totalPasses: number
  /** Tokens received in current stream */
  tokensReceived: number
  /** Total tokens across all passes */
  totalTokens: number
  /** Number of turns in conversation context */
  contextTurns: number
  /** Number of reply turns generated so far */
  repliesGenerated: number
  /** Streaming text buffer for current auto-reply pass */
  streamingText: string
  /** Session list for --list mode */
  sessions: Array<{ id: string; label: string }>
  /** Target directory */
  targetDir: string
  events: Array<{ time: string; message: string }>
}

const MAX_EVENTS = 12

const emitter = new EventEmitter()

const state: MonitorState = {
  phase: "initializing",
  mode: "display",
  sessionId: "",
  turns: [],
  totalTurns: 0,
  trailingDebug: [],
  currentPass: 0,
  totalPasses: 2,
  tokensReceived: 0,
  totalTokens: 0,
  contextTurns: 0,
  repliesGenerated: 0,
  streamingText: "",
  sessions: [],
  targetDir: "",
  events: [],
}

let agoInterval: ReturnType<typeof setInterval> | null = null
let cleanupFn: (() => void) | null = null
let savedStderrWrite: typeof process.stderr.write | null = null
let savedConsoleLog: typeof console.log | null = null
let savedConsoleWarn: typeof console.warn | null = null
let savedConsoleInfo: typeof console.info | null = null
let savedConsoleError: typeof console.error | null = null

function formatTime(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}

function emit(): void {
  emitter.emit("update", state)
}

export const monitor = {
  emitter,

  getState(): MonitorState {
    return state
  },

  setPhase(phase: string): void {
    state.phase = phase
    emit()
  },

  updateStats(partial: Partial<MonitorState>): void {
    Object.assign(state, partial)
    emit()
  },

  pushTurn(turn: DisplayTurn): void {
    state.turns.push(turn)
    emit()
  },

  pushEvent(message: string): void {
    state.events.push({ time: formatTime(), message })
    if (state.events.length > MAX_EVENTS) {
      state.events.splice(0, state.events.length - MAX_EVENTS)
    }
    emit()
  },

  async start(): Promise<void> {
    agoInterval = setInterval(() => {
      emit()
    }, 1000)

    savedConsoleLog = console.log
    savedConsoleWarn = console.warn
    savedConsoleInfo = console.info
    savedConsoleError = console.error
    console.log = () => {}
    console.warn = () => {}
    console.info = () => {}
    console.error = () => {}

    savedStderrWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = () => true

    const { renderMonitor } = await import("./monitor-ui.tsx")
    const result = renderMonitor(monitor)
    cleanupFn = result.cleanup
  },

  stop(): void {
    if (agoInterval !== null) {
      clearInterval(agoInterval)
      agoInterval = null
    }
    if (cleanupFn) {
      cleanupFn()
      cleanupFn = null
    }
    if (savedStderrWrite) {
      process.stderr.write = savedStderrWrite
      savedStderrWrite = null
    }
    if (savedConsoleLog) console.log = savedConsoleLog
    if (savedConsoleWarn) console.warn = savedConsoleWarn
    if (savedConsoleInfo) console.info = savedConsoleInfo
    if (savedConsoleError) console.error = savedConsoleError
    savedConsoleLog = null
    savedConsoleWarn = null
    savedConsoleInfo = null
    savedConsoleError = null
  },
}

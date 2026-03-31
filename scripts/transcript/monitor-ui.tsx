import { Box, render, Static, Text } from "ink"
import { useEffect, useState } from "react"
import type { DisplayTurn, MonitorState, monitor as MonitorType } from "./monitor-state.ts"

const BORDER_COLOR = "cyan"
const LABEL_COLOR = "gray"
const VALUE_COLOR = "white"
const RULE_WIDTH = 60

const PHASE_COLORS: Record<string, string> = {
  initializing: "blue",
  "loading-session": "blue",
  "rendering-turns": "cyan",
  "streaming-pass-1": "green",
  "streaming-pass-2": "green",
  "processing-response": "yellow",
  complete: "cyan",
  error: "red",
}

const ACTIVE_PHASES = new Set([
  "streaming-pass-1",
  "streaming-pass-2",
  "loading-session",
  "initializing",
])
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function phaseColor(phase: string): string {
  return PHASE_COLORS[phase] ?? "white"
}

function Spinner({ color }: { color: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(id)
  }, [])
  return <Text color={color}>{SPINNER_FRAMES[frame]}</Text>
}

const BAR_WIDTH = 16

function ProgressBar({ value, color }: { value: number; color: string }) {
  const clamped = Math.max(0, Math.min(1, value))
  const filled = Math.round(clamped * BAR_WIDTH)
  const empty = BAR_WIDTH - filled
  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color="gray" dimColor>
        {"░".repeat(empty)}
      </Text>
      <Text color={VALUE_COLOR}> {Math.round(clamped * 100)}%</Text>
    </Text>
  )
}

function formatTs(iso?: string): string {
  if (!iso) return ""
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ""
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  } catch {
    return ""
  }
}

function DebugLine({ time, text }: { time: string; text: string }) {
  return (
    <Text dimColor>
      <Text>
        {" "}
        │ {time} {text}
      </Text>
    </Text>
  )
}

function BlockRow({ block }: { block: NonNullable<DisplayTurn["blocks"]>[number] }) {
  if (block.type === "text" && block.text) {
    return <Text> {block.text}</Text>
  }
  if (block.type === "tool_use" && block.toolLabel) {
    return (
      <Text>
        <Text> </Text>
        <Text color="green">⏺</Text>
        <Text dimColor> {block.toolLabel}</Text>
      </Text>
    )
  }
  if (block.type === "tool_result" && block.text) {
    return (
      <Text>
        <Text> </Text>
        <Text color={block.isError ? "red" : undefined} dimColor={!block.isError}>
          {block.isError ? "✗" : "│"}
        </Text>
        <Text dimColor> {block.text}</Text>
      </Text>
    )
  }
  return null
}

function TurnBlock({ turn }: { turn: DisplayTurn }) {
  const isUser = turn.role === "user"
  const ts = formatTs(turn.timestamp)

  return (
    <Box flexDirection="column">
      {turn.debugLines?.map((d) => (
        <DebugLine key={`d-${d.time}-${d.text.slice(0, 20)}`} time={d.time} text={d.text} />
      ))}

      {isUser && turn.text ? (
        <Box flexDirection="column">
          <Text>
            <Text bold color="yellow">
              USER
            </Text>
            {ts ? <Text dimColor> {ts}</Text> : null}
          </Text>
          <Text> {turn.text}</Text>
        </Box>
      ) : null}

      {!isUser && turn.blocks ? (
        <Box flexDirection="column">
          <Text>
            <Text bold color="cyan">
              ASSISTANT
            </Text>
            {ts ? <Text dimColor> {ts}</Text> : null}
          </Text>
          {turn.blocks.map((block) => (
            <BlockRow
              key={`${block.type}-${(block.text ?? block.toolLabel ?? "").slice(0, 30)}`}
              block={block}
            />
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

function SessionList({
  sessions,
  targetDir,
}: {
  sessions: Array<{ id: string; label: string }>
  targetDir: string
}) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        {"\n"} Transcripts for {targetDir}
        {"\n"}
      </Text>
      {sessions.map((s) => (
        <Text key={s.id}>
          <Text> {s.id} </Text>
          <Text dimColor>{s.label}</Text>
        </Text>
      ))}
    </Box>
  )
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "loading-session":
      return "LOADING SESSION"
    case "rendering-turns":
      return "RENDERING"
    case "streaming-pass-1":
      return "GENERATING (PASS 1/2 — FLIPPED ROLES)"
    case "streaming-pass-2":
      return "GENERATING (PASS 2/2 — NORMAL ROLES)"
    case "processing-response":
      return "PROCESSING RESPONSE"
    case "complete":
      return "COMPLETE"
    default:
      return phase.toUpperCase()
  }
}

function PhaseRow({ phase }: { phase: string }) {
  return (
    <Box marginTop={1}>
      {ACTIVE_PHASES.has(phase) && (
        <>
          <Spinner color={phaseColor(phase)} />
          <Text> </Text>
        </>
      )}
      <Text color={LABEL_COLOR}>Phase: </Text>
      <Text bold color={phaseColor(phase)}>
        {phaseLabel(phase)}
      </Text>
    </Box>
  )
}

function EventsList({ events }: { events: MonitorState["events"] }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold color={BORDER_COLOR}>
        Events
      </Text>
      {events.length === 0 ? (
        <Text color="gray" dimColor>
          No events yet
        </Text>
      ) : (
        [...events].reverse().map((e) => (
          <Text key={`${e.time}-${e.message.slice(0, 30)}`} wrap="truncate-end">
            <Text color="gray">{e.time}</Text>
            <Text>{"  "}</Text>
            <Text>{e.message}</Text>
          </Text>
        ))
      )}
    </Box>
  )
}

function AutoReplyPanel({ state }: { state: MonitorState }) {
  const {
    phase,
    currentPass,
    totalPasses,
    tokensReceived,
    totalTokens,
    contextTurns,
    repliesGenerated,
    streamingText,
    events,
  } = state

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1}>
      <Box justifyContent="center">
        <Text bold color={BORDER_COLOR}>
          Transcript Auto-Reply
        </Text>
      </Box>

      <PhaseRow phase={phase} />

      <Box marginTop={1}>
        <Text color={LABEL_COLOR}>Context: </Text>
        <Text bold color={VALUE_COLOR}>
          {contextTurns} turns
        </Text>
        <Text>{"  "}</Text>
        <Text color={LABEL_COLOR}>Replies: </Text>
        <Text bold color={VALUE_COLOR}>
          {repliesGenerated}
        </Text>
      </Box>

      <Box>
        <Text color={LABEL_COLOR}>Tokens: </Text>
        <Text bold color={VALUE_COLOR}>
          {tokensReceived}
        </Text>
        <Text color={LABEL_COLOR}> (current) </Text>
        <Text bold color={VALUE_COLOR}>
          {totalTokens}
        </Text>
        <Text color={LABEL_COLOR}> (total)</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={LABEL_COLOR}>Pass </Text>
        <ProgressBar value={currentPass / totalPasses} color="green" />
      </Box>

      {streamingText ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={BORDER_COLOR}>
            Streaming
          </Text>
          <Text wrap="truncate-end" dimColor>
            {streamingText.slice(-200)}
          </Text>
        </Box>
      ) : null}

      <EventsList events={events} />
    </Box>
  )
}

function turnKey(turn: DisplayTurn): string {
  return `${turn.role}-${turn.timestamp ?? ""}-${(turn.text ?? "").slice(0, 20)}`
}

function DisplayView({ state }: { state: MonitorState }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>Session: {state.sessionId}</Text>
      <Text dimColor>{"─".repeat(RULE_WIDTH)}</Text>

      {state.turns.length === 0 ? (
        <Text dimColor>
          {"\n"} (no conversation turns found){"\n"}
        </Text>
      ) : (
        state.turns.map((turn) => <TurnBlock key={turnKey(turn)} turn={turn} />)
      )}

      {state.trailingDebug.map((d) => (
        <DebugLine key={`td-${d.time}-${d.text.slice(0, 20)}`} time={d.time} text={d.text} />
      ))}

      {state.turns.length > 0 ? (
        <Text dimColor>
          {"\n"}
          {"─".repeat(RULE_WIDTH)}
          {"\n"}
        </Text>
      ) : null}
    </Box>
  )
}

function AutoReplyView({ state }: { state: MonitorState }) {
  return (
    <Box flexDirection="column">
      <Static items={state.turns}>
        {(turn) => (
          <Box key={turnKey(turn)} flexDirection="column">
            <TurnBlock turn={turn} />
          </Box>
        )}
      </Static>
      <AutoReplyPanel state={state} />
    </Box>
  )
}

function useMonitorState(mon: typeof MonitorType): MonitorState {
  const [state, setState] = useState<MonitorState>(mon.getState())
  useEffect(() => {
    const handler = (s: MonitorState) => {
      setState({
        ...s,
        turns: [...s.turns],
        events: [...s.events],
        trailingDebug: [...s.trailingDebug],
        sessions: [...s.sessions],
      })
    }
    mon.emitter.on("update", handler)
    return () => {
      mon.emitter.off("update", handler)
    }
  }, [mon])
  return state
}

function Dashboard({ mon }: { mon: typeof MonitorType }) {
  const state = useMonitorState(mon)

  if (state.mode === "list") {
    return <SessionList sessions={state.sessions} targetDir={state.targetDir} />
  }
  if (state.mode === "auto-reply") return <AutoReplyView state={state} />
  return <DisplayView state={state} />
}

export function renderMonitor(mon: typeof MonitorType): {
  rerender: () => void
  cleanup: () => void
} {
  const instance = render(<Dashboard mon={mon} />, { patchConsole: false })
  return {
    rerender: () => {},
    cleanup: () => {
      instance.unmount()
    },
  }
}

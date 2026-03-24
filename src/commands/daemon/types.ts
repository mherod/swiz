export interface ActiveHookDispatch {
  requestId: string
  canonicalEvent: string
  hookEventName: string
  cwd: string
  sessionId: string | null
  hooks: string[]
  startedAt: number
  toolName?: string
  toolInputSummary?: string
}

export interface ToolCallSummary {
  name: string
  detail: string
}

export interface SessionMessage {
  role: "user" | "assistant"
  timestamp: string | null
  text: string
  toolCalls?: ToolCallSummary[]
}

export interface SessionTaskSummary {
  total: number
  open: number
  completed: number
  cancelled: number
}

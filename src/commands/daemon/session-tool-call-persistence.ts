import { debugLog } from "../../debug.ts"
import { messageFromUnknownError } from "../../utils/hook-json-helpers.ts"
import { persistSessionToolCall } from "./utils.ts"

const MAX_PENDING_CALLS_PER_SESSION = 400

export interface SessionToolCallPersistenceInput {
  cwd: string
  sessionId: string
  toolName: string
  toolInput: Record<string, any> | undefined
  nowMs: number
}

type SessionToolCallWriter = (input: SessionToolCallPersistenceInput) => Promise<void>

interface PendingSessionWrites {
  inputs: SessionToolCallPersistenceInput[]
  draining: Promise<void> | null
}

async function defaultWriter(input: SessionToolCallPersistenceInput): Promise<void> {
  await persistSessionToolCall(
    input.cwd,
    input.sessionId,
    input.toolName,
    input.toolInput,
    input.nowMs
  )
}

export class SessionToolCallPersistenceQueue {
  private readonly pendingBySession = new Map<string, PendingSessionWrites>()

  constructor(
    private readonly writer: SessionToolCallWriter = defaultWriter,
    private readonly maxPendingPerSession = MAX_PENDING_CALLS_PER_SESSION
  ) {}

  enqueue(input: SessionToolCallPersistenceInput): void {
    const key = `${input.cwd}\u0000${input.sessionId}`
    const state = this.pendingBySession.get(key) ?? { inputs: [], draining: null }
    if (state.inputs.length >= this.maxPendingPerSession) state.inputs.shift()
    state.inputs.push(input)
    this.pendingBySession.set(key, state)
    if (!state.draining) {
      state.draining = this.drain(key, state)
    }
  }

  private async drain(key: string, state: PendingSessionWrites): Promise<void> {
    try {
      while (state.inputs.length > 0) {
        const input = state.inputs.shift()!
        try {
          await this.writer(input)
        } catch (error) {
          debugLog(
            `[daemon] failed to persist session tool call for ${input.sessionId}: ${messageFromUnknownError(error)}`
          )
        }
      }
    } finally {
      state.draining = null
      if (state.inputs.length > 0) {
        state.draining = this.drain(key, state)
      } else if (this.pendingBySession.get(key) === state) {
        this.pendingBySession.delete(key)
      }
    }
  }

  async flush(): Promise<void> {
    while (this.pendingBySession.size > 0) {
      const drains = [...this.pendingBySession.values()]
        .map((state) => state.draining)
        .filter((drain): drain is Promise<void> => drain !== null)
      if (drains.length === 0) return
      await Promise.allSettled(drains)
    }
  }

  pendingCount(): number {
    return [...this.pendingBySession.values()].reduce(
      (total, state) => total + state.inputs.length + (state.draining ? 1 : 0),
      0
    )
  }
}

export const sessionToolCallPersistenceQueue = new SessionToolCallPersistenceQueue()

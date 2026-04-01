import { z } from "zod"
import type { ContentBlock, TranscriptEntry } from "./transcript-schemas.ts"
import { toolResultBlockSchema, toolUseBlockSchema } from "./transcript-schemas.ts"
import { splitJsonlLines, tryParseJsonLine } from "./utils/jsonl.ts"

function toolCallLabel(block: { name?: string; input?: Record<string, any> }): string {
  const name = block.name ?? "unknown"
  const input = block.input
  if (!input) return name

  const pathVal = input.path ?? input.file_path
  if (typeof pathVal === "string") return `${name}(${pathVal})`

  if (typeof input.command === "string") {
    // Keep shell commands lossless in transcript-derived context so
    // downstream review/enforcement can see the full operation.
    return `${name}(${input.command})`
  }

  if (typeof input.pattern === "string") return `${name}(${input.pattern})`
  if (typeof input.glob_pattern === "string") return `${name}(${input.glob_pattern})`
  if (typeof input.query === "string") {
    const q = input.query.length > 60 ? `${input.query.slice(0, 57)}...` : input.query
    return `${name}(${q})`
  }

  return name
}
function isToolUseSummaryBlock(block: unknown): block is {
  type: "tool_use"
  name: string
  input?: Record<string, any>
} {
  const result = toolUseBlockSchema.safeParse(block)
  return result.success && typeof result.data.name === "string"
}

export function isToolResultSummaryBlock(block: unknown): block is {
  type: "tool_result"
  content?: string | ContentBlock[]
  is_error?: boolean
} {
  return toolResultBlockSchema.safeParse(block).success
}

export function summarizeToolCalls(content: unknown[]): string {
  const calls = content.filter(isToolUseSummaryBlock).map((b) => toolCallLabel(b))
  if (calls.length === 0) return ""
  return `[Tools: ${calls.join(", ")}]`
}

/**
 * Schema for JSONL transcript entries from Claude and similar providers.
 * Validates the basic structure and provides type-safe access to fields.
 */
const jsonlEntrySchema = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  message: z
    .looseObject({
      role: z.string().optional(),
      content: z.unknown().optional(),
    })
    .optional(),
})

export function parseJsonlEntries(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of splitJsonlLines(text)) {
    const parsed = tryParseJsonLine(line)
    if (parsed === undefined) continue
    const result = jsonlEntrySchema.safeParse(parsed)
    if (!result.success) continue

    const entry = result.data

    // Coerce role → type when type is missing
    if (typeof entry.type !== "string" && typeof entry.role === "string") {
      const role = entry.role
      if (role === "user" || role === "assistant") {
        entry.type = role
      }
    }
    entries.push(entry as TranscriptEntry)
  }
  return entries
}

// ─── Zod schemas for provider-specific transcript records ─────────────────────

/**
 * Schema for Codex message content parts (input_text, output_text).
 * Replaces manual `as Record<string, any>` casts with type-safe validation.
 */
const codexContentPartSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
})

export function parseJunieEvents(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  const lines = splitJsonlLines(text)

  // 1. Pass: Find all AgentStateUpdatedEvent to track state changes
  // and pick the latest one for the base history.
  let latestBlob: any = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === undefined) continue
    const parsed: any = tryParseJsonLine(line)
    if (
      parsed?.event?.agentEvent?.kind === "AgentStateUpdatedEvent" &&
      parsed.event.agentEvent.blob
    ) {
      try {
        latestBlob = JSON.parse(parsed.event.agentEvent.blob)
        if (latestBlob) break
      } catch {}
    }
  }

  if (latestBlob) {
    const lastState = latestBlob.lastAgentState

    // Extract prompt from issueDescription if available
    if (lastState && Array.isArray(lastState.issueDescription)) {
      for (const msg of lastState.issueDescription) {
        const content = msg.parts?.map((p: any) => p.text).join("")
        if (content) {
          entries.push({
            type: "user",
            message: { role: "user", content },
          })
        }
      }
    }

    // Extract conversation history from observations if available
    const observations =
      lastState?.issue?.previousTasksInfo?.agentState?.observations ?? lastState?.observations
    if (Array.isArray(observations)) {
      for (const obs of observations) {
        // Assistant request part
        if (obs.assistantRequest) {
          const content: ContentBlock[] = []
          if (obs.assistantRequest.content) {
            content.push({ type: "text", text: obs.assistantRequest.content })
          }
          if (Array.isArray(obs.assistantRequest.toolUses)) {
            for (const call of obs.assistantRequest.toolUses) {
              const toolName = call.toolCallId?.name
              const input = call.input?.rawJsonObject
              if (toolName) {
                content.push({
                  type: "tool_use",
                  id: call.toolCallId?.id,
                  name: toolName,
                  input: input ?? {},
                })
              }
            }
          }
          if (content.length > 0) {
            entries.push({
              type: "assistant",
              message: { role: "assistant", content },
            })
          }
        }

        // User response part
        if (obs.userResponse?.parts) {
          const content: ContentBlock[] = []
          for (const part of obs.userResponse.parts) {
            if (part.type === "text" && part.text) {
              content.push({ type: "text", text: part.text })
            } else if (part.type === "toolResult" && part.toolResult) {
              content.push({
                type: "tool_result",
                tool_use_id: part.toolResult.toolCallId?.id,
                content: part.toolResult.content,
                is_error: part.toolResult.isError,
              })
            }
          }
          if (content.length > 0) {
            entries.push({
              type: "user",
              message: { role: "user", content },
            })
          }
        }
      }
    }

    // Extract conversation history from lastSessionHistorySnapshot if available,
    // otherwise fallback to blob.history or lastAgentState.history
    const history =
      lastState?.history ?? latestBlob?.history ?? latestBlob?.lastSessionHistorySnapshot?.history
    if (Array.isArray(history)) {
      for (const msg of history) {
        if (msg.kind === "User") {
          const content: ContentBlock[] = []
          for (const part of msg.parts ?? []) {
            if (part.type === "text" && part.text) {
              content.push({ type: "text", text: part.text })
            } else if (part.type === "toolResult" && part.toolResult) {
              content.push({
                type: "tool_result",
                tool_use_id: part.toolResult.toolCallId?.id,
                content: part.toolResult.content,
                is_error: part.toolResult.isError,
              })
            }
          }
          if (content.length > 0) {
            entries.push({
              type: "user",
              message: { role: "user", content },
            })
          }
        } else if (msg.kind === "Agent") {
          const content: ContentBlock[] = []
          for (const part of msg.parts ?? []) {
            if (part.type === "text" && part.text) {
              content.push({ type: "text", text: part.text })
            } else if (part.type === "tool_call") {
              content.push({
                type: "tool_use",
                id: part.id,
                name: part.name,
                input:
                  typeof part.arguments === "string" ? JSON.parse(part.arguments) : part.arguments,
              })
            }
          }
          if (content.length > 0) {
            entries.push({
              type: "assistant",
              message: { role: "assistant", content },
            })
          }
        } else if (msg.kind === "ToolOutput") {
          entries.push({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: msg.toolCallId,
                  content: msg.output,
                  is_error: msg.isError,
                },
              ],
            },
          })
        }
      }
    }
  }

  // 2. Pass: Parse individual events to fill in current turn details
  // and handle streaming thoughts/tool calls.
  for (const line of lines) {
    const parsed: any = tryParseJsonLine(line)
    if (!parsed) continue

    // Handle UserPromptEvent
    if (parsed.kind === "UserPromptEvent" && parsed.prompt) {
      entries.push({
        type: "user",
        timestamp: parsed.timestamp,
        message: { role: "user", content: parsed.prompt },
      })
      continue
    }

    // Handle streamed Assistant content
    if (parsed.event?.agentEvent) {
      const agentEvent = parsed.event.agentEvent
      const kind = agentEvent.kind

      if (
        (kind === "MarkdownBlockUpdatedEvent" || kind === "AgentThoughtBlockUpdatedEvent") &&
        agentEvent.text
      ) {
        entries.push({
          type: "assistant",
          timestamp: parsed.timestamp,
          message: { role: "assistant", content: agentEvent.text },
        })
      } else if (kind === "ToolBlockUpdatedEvent") {
        const content: ContentBlock[] = []
        if (agentEvent.text) {
          content.push({ type: "text", text: agentEvent.text })
        }
        if (agentEvent.toolName) {
          content.push({
            type: "tool_use",
            id: agentEvent.callId || agentEvent.stepId,
            name: agentEvent.toolName,
            input:
              typeof agentEvent.input === "string"
                ? JSON.parse(agentEvent.input)
                : (agentEvent.input ?? {}),
          })
        } else if (agentEvent.text && agentEvent.text.startsWith("Found ")) {
          content.push({
            type: "tool_use",
            id: agentEvent.callId || agentEvent.stepId || "unknown",
            name: "search",
            input: { query: agentEvent.text },
          })
        }
        if (content.length > 0) {
          entries.push({
            type: "assistant",
            timestamp: parsed.timestamp,
            message: { role: "assistant", content },
          })
        }

        if (agentEvent.output !== undefined || agentEvent.details !== undefined) {
          const out = agentEvent.output ?? agentEvent.details ?? ""
          if (out) {
            entries.push({
              type: "user",
              timestamp: parsed.timestamp,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: agentEvent.callId || agentEvent.stepId || "unknown",
                    content: out,
                    is_error: agentEvent.status === "FAILED",
                  },
                ],
              },
            })
          }
        }
      } else if (kind === "TerminalBlockUpdatedEvent") {
        const content: ContentBlock[] = []
        if (agentEvent.command) {
          content.push({
            type: "tool_use",
            id: agentEvent.stepId || "unknown",
            name: "bash",
            input: { command: agentEvent.command },
          })
        }
        if (content.length > 0) {
          entries.push({
            type: "assistant",
            timestamp: parsed.timestamp,
            message: { role: "assistant", content },
          })
        }

        if (agentEvent.output !== undefined || agentEvent.presentableOutput !== undefined) {
          const out = agentEvent.output ?? agentEvent.presentableOutput ?? ""
          entries.push({
            type: "user",
            timestamp: parsed.timestamp,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: agentEvent.stepId || "unknown",
                  content: out,
                  is_error: agentEvent.status === "FAILED",
                },
              ],
            },
          })
        }
      } else if (kind === "ResultBlockUpdatedEvent" && agentEvent.output) {
        entries.push({
          type: "user",
          timestamp: parsed.timestamp,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: agentEvent.callId,
                content: agentEvent.output,
                is_error: agentEvent.isError,
              },
            ],
          },
        })
      }
      continue
    }

    // Handle legacy/other formats
    const result = junieEventSchema.safeParse(parsed)
    if (!result.success) continue

    const event = result.data
    const payload = event.payload
    const timestamp = event.timestamp
    const cwd = event.cwd

    if (payload.type === "user-prompt") {
      entries.push({
        type: "user",
        timestamp,
        cwd,
        message: { role: "user", content: payload.content as string },
      })
    } else if (payload.type === "agent-response") {
      // Map tool calls if present, else just text
      const content: ContentBlock[] = []
      if (typeof payload.content === "string") {
        content.push({ type: "text", text: payload.content })
      }
      if (Array.isArray(payload.tool_calls)) {
        for (const call of payload.tool_calls) {
          content.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          })
        }
      }
      entries.push({
        type: "assistant",
        timestamp,
        cwd,
        message: { role: "assistant", content },
      })
    } else if (payload.type === "tool-output") {
      // Tool results are usually attributed to "user" in Swiz transcript model
      // so they appear as feedback to the assistant.
      entries.push({
        type: "user",
        timestamp,
        cwd,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: payload.tool_call_id,
              content: payload.content,
              is_error: payload.is_error,
            },
          ],
        },
      })
    }
  }
  return entries
}

/**
 * Schema for Junie's events.jsonl records.
 */
const junieEventSchema = z.looseObject({
  type: z.literal("event"),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  payload: z.union([
    z.looseObject({ type: z.literal("user-prompt"), content: z.string() }),
    z.looseObject({
      type: z.literal("agent-response"),
      content: z.string().optional(),
      tool_calls: z
        .array(
          z.looseObject({
            id: z.string(),
            name: z.string(),
            input: z.record(z.string(), z.unknown()),
          })
        )
        .optional(),
    }),
    z.looseObject({
      type: z.literal("tool-output"),
      tool_call_id: z.string(),
      content: z.string(),
      is_error: z.boolean().optional(),
    }),
    z.looseObject({ type: z.string() }), // Fallback for other event types
  ]),
})

function extractCodexMessageText(content: unknown, textType: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return ""
  const texts = content
    .map((part) => {
      const result = codexContentPartSchema.safeParse(part)
      if (!result.success || result.data.type !== textType) return ""
      return result.data.text ?? ""
    })
    .filter(Boolean)
  return texts.join("\n").trim()
}

function parseCodexToolInput(raw: unknown): Record<string, any> {
  const normalize = (value: Record<string, any>): Record<string, any> => {
    if (typeof value.command !== "string" && typeof value.cmd === "string") {
      return { ...value, command: value.cmd }
    }
    return value
  }

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return normalize(raw as Record<string, any>)
  }
  if (typeof raw !== "string") return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, any>
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalize(parsed)
    }
  } catch {}
  return {}
}

// ─── Codex record schemas ─────────────────────────────────────────────────────

/** Schema for Codex session_meta records */
const codexSessionMetaSchema = z.looseObject({
  type: z.literal("session_meta"),
  timestamp: z.string().optional(),
  payload: z.looseObject({
    id: z.string().optional(),
    cwd: z.string().optional(),
  }),
})

/** Schema for Codex event_msg records (user messages) */
const codexEventMsgSchema = z.looseObject({
  type: z.literal("event_msg"),
  timestamp: z.string().optional(),
  payload: z.looseObject({
    type: z.literal("user_message"),
    message: z.string().optional(),
  }),
})

/** Schema for Codex response_item records (assistant messages and tool calls) */
const codexResponseItemSchema = z.looseObject({
  type: z.literal("response_item"),
  timestamp: z.string().optional(),
  payload: z.looseObject({
    type: z.string(),
    role: z.string().optional(),
    content: z.unknown().optional(),
    name: z.string().optional(),
    arguments: z.unknown().optional(),
  }),
})

function classifyCodexLine(
  parsed: unknown,
  sessionId: string | undefined,
  entries: TranscriptEntry[]
): string | undefined {
  const sessionMetaResult = codexSessionMetaSchema.safeParse(parsed)
  if (sessionMetaResult.success) {
    const id = sessionMetaResult.data.payload.id?.trim()
    return id || sessionId
  }

  const eventMsgResult = codexEventMsgSchema.safeParse(parsed)
  if (eventMsgResult.success) {
    const message = eventMsgResult.data.payload.message?.trim()
    if (message) {
      entries.push({
        type: "user",
        sessionId,
        timestamp: eventMsgResult.data.timestamp,
        message: { role: "user", content: message },
      })
    }
    return sessionId
  }

  const responseItemResult = codexResponseItemSchema.safeParse(parsed)
  if (!responseItemResult.success) return sessionId
  classifyCodexResponseItem(responseItemResult.data, sessionId, entries)
  return sessionId
}

interface CodexResponseData {
  timestamp?: string
  payload: { type: string; role?: string; content?: unknown; name?: string; arguments?: unknown }
}

function classifyCodexResponseItem(
  data: CodexResponseData,
  sessionId: string | undefined,
  entries: TranscriptEntry[]
): void {
  const { timestamp, payload } = data
  if (payload.type === "message" && payload.role === "assistant") {
    const text = extractCodexMessageText(payload.content, "output_text")
    if (text) {
      entries.push({
        type: "assistant",
        sessionId,
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text }] },
      })
    }
    return
  }
  if (payload.type === "function_call" && payload.name) {
    entries.push({
      type: "assistant",
      sessionId,
      timestamp,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: payload.name, input: parseCodexToolInput(payload.arguments) },
        ],
      },
    })
  }
}

export function parseCodexJsonlEntries(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let sessionId: string | undefined

  for (const line of splitJsonlLines(text)) {
    const parsed = tryParseJsonLine(line)
    if (parsed === undefined) continue
    sessionId = classifyCodexLine(parsed, sessionId, entries)
  }

  return entries
}

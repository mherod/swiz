import { z } from "zod"

// ─── Content block Zod schemas ────────────────────────────────────────────────

/**
 * Zod schemas for content blocks in transcript messages.
 * Use `contentBlockSchema.safeParse()` for type-safe validation instead of
 * manual `typeof` checks and `as { ... }` casts.
 */

/** Schema for text content blocks: `{ type: "text", text?: string }` */
export const textBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string().optional(),
})

/** Schema for tool_use blocks: `{ type: "tool_use", id?, name?, input? }` */
export const toolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
})

/** Schema for tool_result blocks: `{ type: "tool_result", tool_use_id?, content?, is_error? }` */
export const toolResultBlockSchema: z.ZodType<{
  type: "tool_result"
  tool_use_id?: string
  content?: string | unknown[]
  is_error?: boolean
  [k: string]: unknown
}> = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
})

/** Catch-all schema for unknown content block types */
export const unknownBlockSchema = z.looseObject({
  type: z.string(),
})

/**
 * Content block schema — union of known block types with catch-all fallback.
 * Validates against known block types (text, tool_use, tool_result) and
 * falls back to catch-all for unknown types.
 *
 * Note: Uses `z.union()` instead of `z.discriminatedUnion()` because the
 * catch-all schema uses `z.string()` (non-literal) for the type field.
 *
 * @example
 * const result = contentBlockSchema.safeParse(block)
 * if (result.success && result.data.type === "tool_use") {
 *   // TypeScript knows result.data has name, input, etc.
 * }
 */
export const contentBlockSchema = z.union([
  textBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  unknownBlockSchema,
])

/** Type guard: checks if value is a valid content block */
export function isContentBlock(value: unknown): value is ContentBlock {
  return contentBlockSchema.safeParse(value).success
}

/** Type guard: checks if value is a valid text block with a string `text` field */
export function isTextBlockWithText(value: unknown): value is { type: "text"; text: string } {
  const result = textBlockSchema.safeParse(value)
  return result.success && typeof result.data.text === "string"
}

// ─── Content block TypeScript interfaces (derived from schemas) ───────────────

export type TextBlock = z.infer<typeof textBlockSchema>
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown }

export interface TranscriptEntry {
  type: string
  sessionId?: string
  timestamp?: string
  cwd?: string
  message?: {
    role?: string
    content?: string | ContentBlock[]
  }
}

export interface Session {
  id: string
  path: string
  mtime: number
  provider?: "claude" | "gemini" | "cursor" | "antigravity" | "codex"
  format?:
    | "jsonl"
    | "gemini-json"
    | "cursor-sqlite"
    | "antigravity-pb"
    | "codex-jsonl"
    | "cursor-agent-jsonl"
}

export interface TranscriptResolution {
  raw: string | null
  sourceDescription: string
  formatHint?: Session["format"]
  failureReason?: string
}

/** Simple {role, text} pairs from raw JSONL — shared by continue and stop-auto-continue. */
export interface PlainTurn {
  role: "user" | "assistant"
  text: string
}

/** Single-pass derived views from one parse of a transcript. */
export interface TranscriptData {
  turns: PlainTurn[]
  editedPaths: Set<string>
  toolCallCount: number
}

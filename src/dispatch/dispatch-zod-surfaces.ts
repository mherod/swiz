/**
 * Zod validation at dispatch boundaries: inbound JSON, per-event stdin envelopes,
 * enriched hook payload, and merged agent-visible responses.
 */

import { merge, omit, unset } from "lodash-es"
import { z } from "zod"
import { debugLog } from "../debug.ts"
import {
  codexPostToolUseInputSchema,
  codexPreToolUseInputSchema,
  codexSessionStartInputSchema,
  codexStopInputSchema,
  codexUserPromptSubmitInputSchema,
  hookOutputSchema,
  notificationHookInputSchema,
  postCompactHookInputSchema,
  postToolUseFailureHookInputSchema,
  postToolUseHookInputSchema,
  preCommitHookInputSchema,
  prePushHookInputSchema,
  sessionEndHookInputSchema,
  sessionStartHookInputSchema,
  stopHookExtendedInputSchema,
  stopHookInputSchema,
  stopHookOutputSchema,
  subagentStartHookInputSchema,
  toolHookInputSchema,
  userPromptSubmitHookInputSchema,
} from "../schemas.ts"
import { sanitizeHookOutputForCurrentAgent } from "../utils/hook-output-agent-compat.ts"
import { stripInternalDispatchFields } from "./dispatch-wire.ts"
import { isStopLikeDispatchEvent } from "./stop-response.ts"

/** Top-level dispatch stdin must be a JSON object (not array/primitive). */
export const dispatchInboundObjectSchema = z.record(z.string(), z.unknown())

const fallbackInboundSchema = dispatchInboundObjectSchema

/**
 * Per canonical dispatch route, validate normalized payload (after agent normalization + cwd/session backfills).
 * Unknown events use a plain object record schema.
 */
export const DISPATCH_CANONICAL_INBOUND_SCHEMAS: Record<string, z.ZodType<Record<string, any>>> = {
  preToolUse: z.union([toolHookInputSchema, codexPreToolUseInputSchema]) as z.ZodType<
    Record<string, any>
  >,
  postToolUse: z.union([
    postToolUseHookInputSchema,
    postToolUseFailureHookInputSchema,
    codexPostToolUseInputSchema,
  ]) as z.ZodType<Record<string, any>>,
  stop: z.union([stopHookInputSchema, codexStopInputSchema]) as z.ZodType<Record<string, any>>,
  subagentStop: stopHookExtendedInputSchema as z.ZodType<Record<string, any>>,
  sessionStart: z.union([sessionStartHookInputSchema, codexSessionStartInputSchema]) as z.ZodType<
    Record<string, any>
  >,
  userPromptSubmit: z.union([
    userPromptSubmitHookInputSchema,
    codexUserPromptSubmitInputSchema,
  ]) as z.ZodType<Record<string, any>>,
  preCompact: postCompactHookInputSchema as z.ZodType<Record<string, any>>,
  notification: notificationHookInputSchema as z.ZodType<Record<string, any>>,
  subagentStart: subagentStartHookInputSchema as z.ZodType<Record<string, any>>,
  sessionEnd: sessionEndHookInputSchema as z.ZodType<Record<string, any>>,
  preCommit: preCommitHookInputSchema as z.ZodType<Record<string, any>>,
  prePush: prePushHookInputSchema as z.ZodType<Record<string, any>>,
}

export class DispatchPayloadValidationError extends Error {
  override readonly name = "DispatchPayloadValidationError"
  constructor(
    readonly canonicalEvent: string,
    readonly zodError: z.ZodError
  ) {
    super(`Invalid dispatch payload for event "${canonicalEvent}"`)
  }
}

/**
 * Dispatch stdin must be valid JSON resolving to an object record (not array/primitive).
 * Fatal for every canonical route — no silent `{}` after parse failure.
 */
export function assertDispatchInboundNotParseError(
  canonicalEvent: string,
  parseError: boolean
): void {
  if (!parseError) return
  throw new DispatchPayloadValidationError(
    canonicalEvent,
    new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [],
        message: "stdin must be valid JSON resolving to an object record",
      },
    ])
  )
}

/** Parse stdin JSON and require a top-level object record. */
export function parseDispatchPayloadString(payloadStr: string): {
  payload: Record<string, any>
  parseError: boolean
} {
  let raw: unknown
  try {
    raw = JSON.parse(payloadStr || "{}")
  } catch {
    return { payload: {}, parseError: true }
  }
  const r = dispatchInboundObjectSchema.safeParse(raw)
  if (!r.success) {
    debugLog("[dispatch] inbound JSON is not an object record:", r.error.flatten())
    return { payload: {}, parseError: true }
  }
  return { payload: r.data, parseError: false }
}

/**
 * Validate normalized dispatch payload for the route. On success, returns parsed data (coerced);
 * throws {@link DispatchPayloadValidationError} on failure.
 */
export function assertNormalizedDispatchPayload(
  canonicalEvent: string,
  payload: Record<string, any>
): Record<string, any> {
  const schema = DISPATCH_CANONICAL_INBOUND_SCHEMAS[canonicalEvent] ?? fallbackInboundSchema
  const r = schema.safeParse(payload)
  if (!r.success) {
    debugLog("[dispatch] normalized payload failed schema:", canonicalEvent, r.error.flatten())
    throw new DispatchPayloadValidationError(canonicalEvent, r.error)
  }
  return r.data as Record<string, any>
}

/** Enrichment must still yield an object record before hooks receive stdin. */
export function assertEnrichedDispatchPayloadRecord(value: unknown): Record<string, any> {
  return dispatchInboundObjectSchema.parse(value)
}

function replaceAgentKeysWithParsed(
  response: Record<string, any>,
  parsed: Record<string, any>
): void {
  const hookExec = response.hookExecutions
  for (const k of Object.keys(response)) unset(response, k)
  merge(response, parsed)
  if (hookExec !== undefined) response.hookExecutions = hookExec
}

/**
 * Replace agent-visible keys with `hookOutputSchema` / `stopHookOutputSchema` output.
 * Preserves `hookExecutions`. Skips coercion for internal timeout envelopes `{ error: string }`.
 */
export function coerceDispatchAgentEnvelopeInPlace(
  response: Record<string, any>,
  canonicalEvent: string,
  _hookEventName: string
): void {
  if (typeof response.error === "string" && response.error.length > 0) {
    return
  }

  const agent = omit(response, ["hookExecutions"]) as Record<string, any>
  const compatibleAgent = sanitizeHookOutputForCurrentAgent(agent)

  if (isStopLikeDispatchEvent(canonicalEvent)) {
    const parsed = stopHookOutputSchema.parse(compatibleAgent) as Record<string, any>
    replaceAgentKeysWithParsed(response, parsed)
  } else {
    const parsed = hookOutputSchema.parse(compatibleAgent) as Record<string, any>
    replaceAgentKeysWithParsed(response, parsed)
  }
}

/** Agent-visible JSON for HTTP/stdout — strip internals then parse to enforce schema. */
export function parseValidatedAgentDispatchWireJson(
  response: Record<string, any>,
  canonicalEvent: string,
  _hookEventName: string
): Record<string, any> {
  if (typeof response.error === "string" && response.error.length > 0) {
    return z.object({ error: z.string().min(1) }).parse(stripInternalDispatchFields(response))
  }
  const agent = sanitizeHookOutputForCurrentAgent(stripInternalDispatchFields(response))
  const schema = isStopLikeDispatchEvent(canonicalEvent) ? stopHookOutputSchema : hookOutputSchema
  return schema.parse(agent) as Record<string, any>
}

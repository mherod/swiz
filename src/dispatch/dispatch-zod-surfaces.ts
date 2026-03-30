/**
 * Zod validation at dispatch boundaries: inbound JSON, per-event stdin envelopes,
 * enriched hook payload, and merged agent-visible responses.
 */

import { merge, omit, unset } from "lodash-es"
import { z } from "zod"
import {
  hookOutputSchema,
  notificationHookInputSchema,
  postCompactHookInputSchema,
  postToolUseHookInputSchema,
  preCommitHookInputSchema,
  prPollHookInputSchema,
  sessionEndHookInputSchema,
  sessionStartHookInputSchema,
  stopHookExtendedInputSchema,
  stopHookOutputSchema,
  subagentStartHookInputSchema,
  toolHookInputSchema,
  userPromptSubmitHookInputSchema,
} from "../../hooks/schemas.ts"
import { debugLog } from "../debug.ts"
import { stripInternalDispatchFields } from "./dispatch-wire.ts"
import { isStopLikeDispatchEvent } from "./stop-response.ts"

/** Top-level dispatch stdin must be a JSON object (not array/primitive). */
export const dispatchInboundObjectSchema = z.record(z.string(), z.unknown())

const fallbackInboundSchema = dispatchInboundObjectSchema

/**
 * Per canonical dispatch route, validate normalized payload (after agent normalization + cwd/session backfills).
 * Unknown events use a plain object record schema.
 */
export const DISPATCH_CANONICAL_INBOUND_SCHEMAS: Record<
  string,
  z.ZodType<Record<string, unknown>>
> = {
  preToolUse: toolHookInputSchema as z.ZodType<Record<string, unknown>>,
  postToolUse: postToolUseHookInputSchema as z.ZodType<Record<string, unknown>>,
  stop: stopHookExtendedInputSchema as z.ZodType<Record<string, unknown>>,
  subagentStop: stopHookExtendedInputSchema as z.ZodType<Record<string, unknown>>,
  sessionStart: sessionStartHookInputSchema as z.ZodType<Record<string, unknown>>,
  userPromptSubmit: userPromptSubmitHookInputSchema as z.ZodType<Record<string, unknown>>,
  preCompact: postCompactHookInputSchema as z.ZodType<Record<string, unknown>>,
  notification: notificationHookInputSchema as z.ZodType<Record<string, unknown>>,
  subagentStart: subagentStartHookInputSchema as z.ZodType<Record<string, unknown>>,
  sessionEnd: sessionEndHookInputSchema as z.ZodType<Record<string, unknown>>,
  prPoll: prPollHookInputSchema as z.ZodType<Record<string, unknown>>,
  preCommit: preCommitHookInputSchema as z.ZodType<Record<string, unknown>>,
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
  payload: Record<string, unknown>
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
  payload: Record<string, unknown>
): Record<string, unknown> {
  const schema = DISPATCH_CANONICAL_INBOUND_SCHEMAS[canonicalEvent] ?? fallbackInboundSchema
  const r = schema.safeParse(payload)
  if (!r.success) {
    debugLog("[dispatch] normalized payload failed schema:", canonicalEvent, r.error.flatten())
    throw new DispatchPayloadValidationError(canonicalEvent, r.error)
  }
  return r.data as Record<string, unknown>
}

/** Enrichment must still yield an object record before hooks receive stdin. */
export function assertEnrichedDispatchPayloadRecord(value: unknown): Record<string, unknown> {
  return dispatchInboundObjectSchema.parse(value)
}

function replaceAgentKeysWithParsed(
  response: Record<string, unknown>,
  parsed: Record<string, unknown>
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
  response: Record<string, unknown>,
  canonicalEvent: string,
  _hookEventName: string
): void {
  if (typeof response.error === "string" && response.error.length > 0) {
    return
  }

  const agent = omit(response, ["hookExecutions"]) as Record<string, unknown>

  if (isStopLikeDispatchEvent(canonicalEvent)) {
    const parsed = stopHookOutputSchema.parse(agent) as Record<string, unknown>
    replaceAgentKeysWithParsed(response, parsed)
  } else {
    const parsed = hookOutputSchema.parse(agent) as Record<string, unknown>
    replaceAgentKeysWithParsed(response, parsed)
  }
}

/** Agent-visible JSON for HTTP/stdout — strip internals then parse to enforce schema. */
export function parseValidatedAgentDispatchWireJson(
  response: Record<string, unknown>,
  canonicalEvent: string,
  _hookEventName: string
): Record<string, unknown> {
  if (typeof response.error === "string" && response.error.length > 0) {
    return z.object({ error: z.string().min(1) }).parse(stripInternalDispatchFields(response))
  }
  const agent = stripInternalDispatchFields(response)
  const schema = isStopLikeDispatchEvent(canonicalEvent) ? stopHookOutputSchema : hookOutputSchema
  return schema.parse(agent) as Record<string, unknown>
}

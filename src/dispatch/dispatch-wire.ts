/**
 * Agent-visible vs internal fields on merged dispatch JSON.
 * Kept in a tiny module so engine, HTTP handlers, and Zod coercion can share it
 * without import cycles.
 */

import { omit } from "lodash-es"

export const INTERNAL_DISPATCH_RESPONSE_KEYS = ["hookExecutions"] as const

/** Clone dispatch JSON without internal telemetry fields for agent-visible output. */
export function stripInternalDispatchFields(response: Record<string, any>): Record<string, any> {
  return omit(response, [...INTERNAL_DISPATCH_RESPONSE_KEYS])
}

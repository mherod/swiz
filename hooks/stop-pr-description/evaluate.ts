/**
 * Main orchestration module for stop-pr-description.
 *
 * Resolves context, runs validators, and returns blocking output or empty object.
 */

import type { SwizHookOutput } from "../../src/SwizHook.ts"
import type { StopHookInput } from "../../src/schemas.ts"
import {
  buildEmptyDescriptionOutput,
  buildPlaceholderOutput,
  buildTooShortOutput,
} from "./action-plan.ts"
import { isEmptyDescription, isTooShortDescription } from "./completeness-validator.ts"
import { resolvePRCheckContext } from "./context.ts"
import { hasPlaceholderPattern, hasSummaryPlaceholder } from "./format-validator.ts"

/**
 * Evaluate PR description and return blocking output or empty object.
 */
export async function evaluateStopPrDescription(input: StopHookInput): Promise<SwizHookOutput> {
  const ctx = await resolvePRCheckContext(input)
  if (!ctx) return {}

  // Check completeness first (empty description)
  if (isEmptyDescription(ctx.prBody)) {
    return buildEmptyDescriptionOutput(ctx)
  }

  // Check format (placeholder patterns)
  if (hasSummaryPlaceholder(ctx.prBody) || hasPlaceholderPattern(ctx.prBody)) {
    return buildPlaceholderOutput(ctx)
  }

  // Check minimum content length
  if (isTooShortDescription(ctx.prBody)) {
    const state = {
      isEmpty: false,
      hasPlaceholder: false,
      isTooShort: true,
      minCharCount: 20,
    }
    return buildTooShortOutput(ctx, state)
  }

  return {}
}

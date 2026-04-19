import { BlockingStrategy } from "./blockingStrategy.ts"
import { ContextStrategy } from "./contextStrategy.ts"
import { PreToolUseStrategy } from "./preToolUseStrategy.ts"
import {
  type HookExecutionStrategy,
  type HookStrategyContext,
  runStrategyPipeline,
} from "./strategy-base.ts"
import type { DispatchStrategy } from "./types.ts"

// Re-export for barrel compatibility
export type { HookExecutionStrategy, HookStrategyContext }
export { runStrategyPipeline }

/** Registry mapping dispatch strategy names to their implementations. */
export const STRATEGY_REGISTRY: Record<DispatchStrategy, HookExecutionStrategy> = {
  preToolUse: new PreToolUseStrategy(),
  blocking: new BlockingStrategy(),
  context: new ContextStrategy(),
}

# Phase 2 Hook Extraction Pattern

## Overview

Phase 2 extracts monolithic stop hooks into modular validation layers. Each extraction follows a consistent 6-module architecture designed for independent testability, reusability, and parallel orchestration.

## Canonical 6-Module Structure

### 1. **types.ts**
Defines domain-specific types and interfaces that represent the input/output contracts for the validation pipeline.

**Purpose**: Establish clear type boundaries between modules.
**Contains**: `TaskCheckContext`, `TaskCheckResult`, or equivalent domain types.
**Pattern**:
```typescript
export interface TaskCheckContext {
  sessionId: string
  home: string
  tasksDir: string | null
  allTasks: SessionTask[]
}
```

### 2. **context.ts**
Resolves runtime prerequisites: directories, session IDs, file paths, and initial data reads.

**Purpose**: Fail-open error handling—return `null` when prerequisites can't be met.
**Contains**: `resolveTaskCheckContext()` function.
**Pattern**:
```typescript
export async function resolveTaskCheckContext(input: StopHookInput): Promise<TaskCheckContext | null> {
  const sessionId = resolveSafeSessionId(input.session_id)
  if (!sessionId) return null
  
  const home = homedir()
  const tasksDir = getSessionTasksDir(sessionId, home)
  if (!tasksDir) return null
  
  const allTasks = await readSessionTasks(sessionId, home)
  return { sessionId, home, tasksDir, allTasks }
}
```

### 3. **Validators** (1-3 focused modules)
Independent, single-responsibility validators. Each file checks one concern (deduplication, status filtering, pattern matching, etc.).

**Purpose**: Parallel execution and independent testability.
**Pattern**:
- `task-dedup-validator.ts` → `deduplicateStaleTasks()`
- `incomplete-check-validator.ts` → `getIncompleteDetails()`, `filterIncompleteStatus()`
- Domain-specific validators as needed

**Key principle**: Validators modify state in place and return nothing. Side effects (writes) happen here with fail-open error handling.

### 4. **action-plan.ts**
Formats the validation result into a human-readable blocking message or hook output.

**Purpose**: Separate presentation logic from business logic.
**Contains**: `formatIncompleteReason()`, `buildIncompleteBlockOutput()`.
**Pattern**:
```typescript
export function buildIncompleteBlockOutput(taskDetails: string[]): SwizHookOutput {
  const reason = formatIncompleteReason(taskDetails)
  return blockStopObj(reason)
}
```

### 5. **evaluate.ts**
Orchestrates all validators in sequence. This is the main entry point.

**Purpose**: Coordinate prerequisite resolution, validation, and output generation.
**Pattern**:
```typescript
export async function evaluateStopIncompleteTasks(input: StopHookInput): Promise<SwizHookOutput> {
  const ctx = await resolveTaskCheckContext(input)
  if (!ctx) return {}

  // Run validators sequentially or in parallel
  await deduplicateStaleTasks(ctx.completedTasks, ctx.incompleteTasks, ctx.tasksDir, autoTransition, ctx.sessionId)
  
  const remainingIncomplete = filterIncompleteStatus(ctx.allTasks)
  if (remainingIncomplete.length === 0) return {}

  const taskDetails = getIncompleteDetails(ctx.allTasks)
  return buildIncompleteBlockOutput(taskDetails)
}
```

### 6. **<hook-name>.ts** (wrapper)
Thin wrapper that delegates to `evaluate.ts`. Contains only the hook registration and boilerplate.

**Purpose**: Maintain hook interface while delegating logic to evaluate module.
**Pattern**:
```typescript
export async function evaluatePosttooluseGitTaskAutocomplete(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  return await evaluateStopIncompleteTasks(hookInput)
}

const hook: SwizHook = {
  name: "stop-incomplete-tasks",
  event: "stop",
  run(input) {
    return evaluateStopIncompleteTasks(input)
  },
}

export default hook
```

## Deduplication Resolution Strategy

When hooks are extracted, functions may already exist in canonical core utilities (e.g., `src/utils/stop-incomplete-tasks-core.ts`). Don't reimplement—**consolidate**:

1. **Export from core** (`src/utils/stop-incomplete-tasks-core.ts`):
   ```typescript
   export function getIncompleteDetails(allTasks: SessionTask[]): string[] { ... }
   export async function deduplicateStaleTasks(...): Promise<void> { ... }
   ```

2. **Import by orchestrator** (evaluate.ts only):
   ```typescript
   import { getIncompleteDetails, deduplicateStaleTasks } from "../../src/utils/stop-incomplete-tasks-core.ts"
   ```

3. **Validators import core functions if needed**:
   - Keep validators focused on filtering/formatting only
   - Move heavy lifting (deduplication, state modification) to core or separate core-imported functions

4. **Delete thin wrapper modules** if they only re-export:
   - If `task-dedup-validator.ts` only contains `export { deduplicateStaleTasks }`, delete it
   - Import directly in `evaluate.ts` instead

## Phase 2.1 Completed Example: stop-incomplete-tasks

**Extracted**: 
- `hooks/stop-incomplete-tasks/types.ts` — `TaskCheckContext`
- `hooks/stop-incomplete-tasks/context.ts` — `resolveTaskCheckContext()`
- `hooks/stop-incomplete-tasks/incomplete-check-validator.ts` — `filterIncompleteStatus()`
- `hooks/stop-incomplete-tasks/action-plan.ts` — `buildIncompleteBlockOutput()`
- `hooks/stop-incomplete-tasks/evaluate.ts` — `evaluateStopIncompleteTasks()`
- `hooks/stop-incomplete-tasks.ts` — hook wrapper

**Core consolidation**:
- `getIncompleteDetails`, `deduplicateStaleTasks`, `completeStaleTask` → exported from `src/utils/stop-incomplete-tasks-core.ts`
- Evaluated directly by `evaluate.ts`

**Result**:
- 100% test coverage (3/3 tests pass)
- No duplication violations
- Commit 9906fd1 deployed to main with CI success

## Next Extractions (Phase 2.2)

1. **stop-branch-conflicts** — Check for branch divergence, unmerged conflicts
2. **stop-pr-description** — Validate PR body format and completeness
3. **stop-pr-changes-requested** — Complete extraction of PR review feedback logic
4. **stop-ship-checklist** — Decompose git/CI/issues validation into independent checks

## Guidelines

- **Independent testability**: Each validator module should be testable in isolation.
- **Fail-open**: Return `null` from context resolution or skip validators gracefully on missing prerequisites.
- **Single responsibility**: One concern per validator file (dedup, filter, check, format, etc.).
- **Reusability**: Export from core if functions exist elsewhere; import by orchestrator, not by validators.
- **No duplication**: Duplication detector (`similar` hook) blocks commits with 3+ exact duplicates. Consolidate before pushing.
- **Module order**: Types → Context → Validators → Action-plan → Evaluate → Wrapper.

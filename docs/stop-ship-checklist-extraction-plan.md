# Stop-Ship-Checklist Extraction Plan

**Target**: Modularize stop-ship-checklist.ts into three separable concerns using the stop-pr-feedback extraction pattern.

## Current Monolithic Structure

**File**: `hooks/stop-ship-checklist.ts` (309 lines)

**Three Combined Concerns**:

1. **Git Workflow** (delegated to stop-git-status.ts)
   - Uncommitted changes
   - Unpushed commits
   - Commit/pull/push workflow

2. **GitHub CI** (internal, lines 54-196)
   - CI run polling (5s intervals, max 30s)
   - Failing vs active run detection
   - Action plan generation for fixing/waiting

3. **Issues and PRs** (delegated to stop-personal-repo-issues/evaluate.ts)
   - Unassigned issues
   - Review feedback on PRs
   - Action plan generation for issue triage

**Current Flow** (evaluateStopShipChecklist, lines 198-292):
```
Input (StopHookInput)
  ↓
Load settings (gitStatusGate, githubCiGate, personalRepoIssuesGate)
  ↓
Branch 1: collectGitWorkflowStop()     → GitWorkflowCollectResult or SwizHookOutput
Branch 2: collectGithubCiStopParsed()  → CIBlockResult | null
Branch 3: collectPersonalRepoIssuesStopParsed() → IssuesBlockResult | null
  ↓
Unify results into single action plan
  ↓
Create session tasks (via mergeActionPlanIntoTasks)
  ↓
Emit blockStopObj(preamble + plan)
```

## Target Modular Structure

Following the stop-pr-feedback extraction pattern:

```
hooks/
├── stop-ship-checklist.ts              # Main hook entry (SwizStopHook registration)
└── stop-ship-checklist/
    ├── types.ts                         # Domain interfaces
    ├── context.ts                       # Settings resolution + workflow prerequisites
    ├── git-workflow.ts                  # Git sync collection (reuse from stop-git-status.ts)
    ├── ci-workflow.ts                   # CI run polling, filtering, action planning
    ├── issues-workflow.ts               # Issue/PR gathering (reuse from stop-personal-repo-issues)
    ├── action-plan.ts                   # Unified action plan generation
    └── evaluate.ts                      # Main orchestration logic
```

## Module Responsibilities

### types.ts

Define unified workflow interfaces:

```typescript
interface WorkflowGate {
  git: boolean
  ci: boolean
  issues: boolean
}

interface WorkflowStep {
  kind: 'git' | 'ci' | 'issues'
  summary: string
  planSteps: ActionPlanItem[]
}

interface ShipChecklistContext {
  cwd: string
  sessionId: string | undefined
  gates: WorkflowGate
  // Load all necessary prerequisite state
}

interface ShipChecklistResult {
  blocked: boolean
  steps: WorkflowStep[]  // Ordered by workflow sequence
}
```

### context.ts

**Purpose**: Validate prerequisites and load settings for all three gates.

```typescript
async function resolveShipChecklistContext(
  input: StopHookInput
): Promise<ShipChecklistContext | null>

// Check:
// 1. Is this a git repo?
// 2. Does it have GitHub remote?
// 3. Load settings for gitStatusGate, githubCiGate, personalRepoIssuesGate
// 4. Determine current branch
// 5. Fail-open: return null if any prerequisite fails
```

**Reusable helpers**:
- `resolveTargetBranch()` (already in stop-ship-checklist.ts, move here)
- `loadGateSettings()` (extract from evaluateStopShipChecklist)

### git-workflow.ts

**Purpose**: Git sync workflow collection.

**Source**: Reuse `collectGitWorkflowStop()` from stop-git-status.ts

```typescript
export async function collectGitWorkflow(
  input: StopHookInput
): Promise<GitWorkflowStep | null>

// Returns: { kind: 'git', summary, planSteps }
// Or null if no git workflow is blocking
```

**No changes needed** — this concern is already encapsulated in stop-git-status.ts. Just import and call.

### ci-workflow.ts

**Purpose**: GitHub CI polling, filtering, action plan generation.

**Current implementation** (lines 54-196 of stop-ship-checklist.ts):

Extract and refactor:

```typescript
export async function collectCiWorkflow(
  context: ShipChecklistContext
): Promise<CIWorkflowStep | null>

// Calls:
// 1. resolveTargetBranch() → determine branch
// 2. fetchRuns() → poll CI runs (store-first caching)
// 3. findActive() / findFailing() → partition runs
// 4. buildFailingResult() / buildActiveResult() → action plan
// Returns: { kind: 'ci', summary, planSteps }
// Or null if no CI is blocking

interface CIWorkflowStep {
  kind: 'ci'
  summary: string
  planSteps: ActionPlanItem[]
}
```

**Implementation patterns**:
- Store-first caching via `getIssueStoreReader().getCiBranchRuns()` + `getIssueStore().upsertCiBranchRuns()`
- Polling with exponential backoff (5s intervals, max 30s)
- Fail-open: returns null on missing prerequisites (no branch, no GitHub remote)

### issues-workflow.ts

**Purpose**: Issues and PRs workflow collection.

**Source**: Reuse `collectPersonalRepoIssuesStopParsed()` from stop-personal-repo-issues/evaluate.ts

```typescript
export async function collectIssuesWorkflow(
  input: StopHookInput
): Promise<IssuesWorkflowStep | null>

// Returns: { kind: 'issues', summary, planSteps }
// Or null if no issues are blocking
```

**No changes needed** — this concern is already in stop-personal-repo-issues. Just import and call, rename return type.

### action-plan.ts

**Purpose**: Unify action plans from all three workflows into a single numbered checklist.

```typescript
function buildUnifiedActionPlan(
  steps: WorkflowStep[]
): { preamble: string; plan: string }

// Preamble: "You cannot stop until everything below is resolved..."
// Plan: Numbered checklist combining all workflow steps
// Ordering: Git → CI → Issues (workflow sequence)

// Respects workflow settings:
// - If gitStatusGate=false, skip git section
// - If githubCiGate=false, skip ci section
// - If personalRepoIssuesGate=false, skip issues section
```

### evaluate.ts

**Purpose**: Orchestrate the full evaluation flow.

```typescript
export async function collectShipChecklistStopParsed(
  input: StopHookInput
): Promise<ShipChecklistResult | null>

// Main orchestration:
// 1. resolveShipChecklistContext()
// 2. Parallel: collectGitWorkflow(), collectCiWorkflow(), collectIssuesWorkflow()
// 3. Filter by gates (enabled settings)
// 4. buildUnifiedActionPlan()
// 5. Create session tasks (mergeActionPlanIntoTasks)
// 6. Return result

export async function evaluateStopShipChecklist(
  input: StopHookInput
): Promise<SwizHookOutput>

// Entry point:
// 1. Call collectShipChecklistStopParsed()
// 2. If no blocks, return {}
// 3. Otherwise, blockStopObj(preamble + plan)
```

**Error Handling** (fail-open pattern):
- All async operations wrapped in try-catch
- Returns null on missing prerequisites (branch, repo, gh CLI)
- Returns empty result {} if all gates are disabled
- Never throws

## Implementation Challenges

### 1. **Reusability vs Ownership**

**Problem**: Git workflow is in stop-git-status.ts, issues workflow is in stop-personal-repo-issues. Do we extract common helpers?

**Solution**: 
- Keep stop-git-status.ts and stop-personal-repo-issues as separate, focused hooks
- Export a "parsed" function (e.g., `collectGitWorkflowStop()`) that returns structured data without emitting SwizHookOutput
- Stop-ship-checklist imports and calls these functions, then unifies their outputs

This maintains separation of concerns: each hook can run standalone AND be composed in unified workflows.

### 2. **Store-First Caching Coordination**

**Problem**: All three workflows use IssueStore. Concurrent polling could cause cache thrashing.

**Solution**:
- Use per-workflow cache keys (e.g., `getCiBranchRuns(repo, branch)`)
- Rely on IssueStore's internal locking/MVCC for thread-safety
- Keep cache TTLs separate (issues → session-based, CI runs → 5-min window)

### 3. **Settings Resolution Complexity**

**Problem**: Three independent gates (gitStatusGate, githubCiGate, personalRepoIssuesGate) with defaults. Need to load once, not three times.

**Solution**:
- Load settings once in `context.ts` → `resolveShipChecklistContext()`
- Return a WorkflowGate object with all three flags
- Pass context to each workflow function

### 4. **Action Plan Ordering**

**Problem**: Agent sees a single numbered plan. Order must be logical: git → ci → issues.

**Solution**:
- define fixed order in buildUnifiedActionPlan()
- If git is blocking, it's step 1
- If ci is blocking, it's step 2
- If issues are blocking, it's step 3
- Skipped blocks don't appear in the plan

### 5. **Task Creation and Merging**

**Problem**: Each workflow may create its own tasks. Do we merge them?

**Solution**:
- Current behavior: `mergeActionPlanIntoTasks()` called once per workflow
- After unification: call `mergeActionPlanIntoTasks(unifiedPlan)` once
- Task subject: "Complete ship checklist" (unified, not per-workflow)
- Task description: lists all active concerns (git + ci + issues)

## Testing Strategy

### Unit Tests (stop-ship-checklist.test.ts)

- Partition CI runs: active vs failing, by workflow name, by creation time
- Build action plans: failing workflow messaging, active workflow messaging
- Settings resolution: gates enabled/disabled, defaults

### Integration Tests (stop-ship-checklist-integration.test.ts)

- All three workflows active → unified plan has 3 sections
- Two workflows active → unified plan has 2 sections
- Git and issues active, CI disabled → plan has git + issues only
- Manifest ordering: stop-ship-checklist runs after other git/ci/issue hooks

### Production Scenarios (stop-ship-checklist-production-scenarios.test.ts)

- All three blocking → single unified output
- Only git blocking → git checklist
- Only CI blocking → CI checklist
- Only issues blocking → issues checklist
- None blocking → returns {}
- Hooks fail-open gracefully on missing context

## Performance Targets

- **Cached**: <500ms (IssueStore lookups + local filtering)
- **CI cold**: <2s + polling delay (up to 30s if CI is active)
- **Issues cold**: <1.5s (GitHub API, local filtering)
- **Combined worst-case**: ~33s (30s CI poll + API overhead)

## Commit Sequence

1. **Extract types and context** → types.ts, context.ts
2. **Extract CI workflow** → ci-workflow.ts with all helper functions
3. **Extract action plan** → action-plan.ts
4. **Extract evaluate** → evaluate.ts, orchestration + entry point
5. **Update main hook** → imports and delegates to evaluate.ts
6. **Add comprehensive tests** → unit, integration, production scenarios
7. **Update README** → document modular structure, breaking concerns

## Next Steps After Extraction

- Verify all 3 gates work independently + in combination
- Performance baseline: measure real-world response times
- Team applies pattern to stop-completion-auditor (next candidate)
- Gather feedback on pattern clarity and refinement needs

# Hook Extraction Pattern

Reference pattern for extracting concerns from monolithic stop hooks into focused, reusable modules.

## Overview

The **stop-pr-feedback** hook demonstrates a clean extraction pattern that separates GitHub pull request review feedback handling from general issue triage. This pattern can be applied to other hooks that combine multiple concerns.

## Directory Structure

```
hooks/
├── stop-pr-feedback.ts          # Main hook entry point (SwizStopHook registration)
└── stop-pr-feedback/
    ├── types.ts                 # TypeScript interfaces and types
    ├── context.ts               # Context resolution and gathering
    ├── pull-requests.ts         # PR fetching, filtering, partitioning
    ├── action-plan.ts           # Action plan generation for blocking reasons
    └── evaluate.ts              # Main evaluation logic (orchestration)
```

## Core Components

### 1. Types Module (`types.ts`)
- Define all TypeScript interfaces for the module
- Examples: `PR`, `RepoContext`, `StopContext`
- Keep minimal and focused on domain concepts
- No external dependencies within types

### 2. Context Module (`context.ts`)
- Resolve environmental context (cwd, session, repo ownership)
- Gather prerequisite data before evaluation
- Handle graceful failures with null returns (fail-open pattern)
- Examples: `resolveRepoContext()`, `gatherPRFeedback()`

### 3. Data Fetching Module (`pull-requests.ts`)
- Implement GitHub API queries and caching strategy
- Use IssueStore for store-first caching
- Parallel queries with `Promise.all()` for efficiency
- Partition and filter data locally
- Example: `getOpenPRsWithFeedback()`, `partitionPRsForStop()`

### 4. Action Planning Module (`action-plan.ts`)
- Generate structured action plans for blocking reasons
- Build stop reason messages
- Create task suggestions for agents
- Keep logic focused on "what to do" guidance

### 5. Evaluation Module (`evaluate.ts`)
- Orchestrate the full evaluation flow
- Call context → fetch → partition → plan → block
- Handle errors gracefully with fail-open
- Return `SwizHookOutput` for hook dispatch

### 6. Main Hook File (`stop-pr-feedback.ts`)
- Register `SwizStopHook` with manifest
- Import and export evaluation function
- Set timeout and cooldown parameters
- Optionally include subprocess entry point

## Implementation Patterns

### Pattern 1: Fail-Open Error Handling
```typescript
try {
  const ctx = await resolveRepoContext(parsed)
  if (!ctx) return null  // fail-open: conditions not met
  // ... continue processing
} catch {
  return null  // fail-open: don't block on errors
}
```

### Pattern 2: Store-First Caching
```typescript
// Try cache first
const store = getIssueStore()
const cached = store.listPullRequests(repoSlug)
if (cached && hasCompleteData(cached)) {
  return filterAndReturn(cached)
}
// Fall back to API
const fresh = await ghJson(...)
store.upsert(repoSlug, fresh)
return fresh
```

### Pattern 3: Parallel Data Fetching
```typescript
const [authored, reviewed] = await Promise.all([
  ghJson(['pr', 'list', '--author', user, ...]),
  ghJson(['pr', 'list', '--reviewer', user, ...]),
])
```

### Pattern 4: Local Deduplication
```typescript
const byNumber = new Map<number, PR>()
for (const pr of [...authored, ...reviewed]) {
  byNumber.set(pr.number, pr)  // Dedup by primary key
}
return [...byNumber.values()]
```

## Testing Strategy

### Unit Tests (`hook.test.ts`)
- Test individual functions: filtering, partitioning, ordering
- Test edge cases: empty arrays, missing fields, invalid data
- No external dependencies or API calls

### Integration Tests (`hook-integration.test.ts`)
- Test hook composition with complementary hooks
- Verify separation of concerns
- Ensure messages don't duplicate between hooks

### Production Scenarios (`hook-production-scenarios.test.ts`)
- Real-world blocking conditions: CHANGES_REQUESTED, merge conflicts
- Non-blocking states: approved, no PRs
- Safe integration with dispatch system

## Caching and Performance

**Cache Strategy:** Store-first with write-back
- Zero I/O for cached lookups (<100ms)
- Parallel API calls for cold starts (<2s)
- Automatic invalidation on store updates
- Write back on successful API response

**Optimization Points:**
1. Parallel `ghJson()` calls for author + reviewer PRs
2. Local in-memory deduplication (no re-fetches)
3. IssueStore caching eliminates redundant calls
4. Fail-open prevents error cascades

## Manifest Registration

Add to `src/manifest.ts`:

```typescript
import stopPrFeedback from "../hooks/stop-pr-feedback.ts"

// In stop event hooks array, in correct order:
{ hook: stopPrFeedback },  // PR feedback checked before issues
{ hook: stopPersonalRepoIssues },
```

## Separation of Concerns

**stop-pr-feedback** responsibility:
- PR review feedback (CHANGES_REQUESTED, REVIEW_REQUIRED)
- Merge conflicts (CONFLICTING status)

**stop-personal-repo-issues** responsibility (after extraction):
- Issue triage and assignments
- Label-based filtering and suggestions

**Never combine:** PR logic and issue triage should not be in the same hook.

## Documentation

- Update `README.md` with hook description in Stop hooks table
- Include blocking conditions and purpose
- Link to related hooks if any

## Example: Complete Workflow

```typescript
// 1. Resolve context
const ctx = await resolveRepoContext(input)  // → RepoContext | null

// 2. Gather PR feedback
const prs = await gatherPRFeedback(ctx.cwd, ctx.currentUser)  // → PR[]

// 3. Build stop context
const stopCtx = buildStopContext(ctx, prs)  // → StopContext | null

// 4. Generate action plan
const planSteps = buildStopPlanSteps(stopCtx)  // → ActionPlanItem[]

// 5. Format message
const reason = formatStopReason(planSteps)  // → string

// 6. Create blocking output
return blockStopObj(reason)  // → SwizHookOutput
```

## Reusability Checklist

- [ ] Module structure follows types → context → data → action-plan → evaluate pattern
- [ ] All functions are independently testable
- [ ] Error handling is fail-open (returns null/empty, never throws)
- [ ] Caching strategy is documented and efficient
- [ ] Tests cover unit, integration, and production scenarios
- [ ] Manifest registration is correct and ordered
- [ ] README documentation is complete
- [ ] No circular dependencies between modules
- [ ] Clear separation of concerns with related hooks

## Next Hooks to Extract

Candidates for this pattern:
1. **stop-ship-checklist** — Combine git status, CI waiting, and issues guidance
2. **stop-completion-auditor** — Multiple validation layers
3. **stop-git-status** + **stop-lockfile-drift** — Git state concerns could be separated

Apply this pattern when a hook has multiple responsibilities that can be tested independently.

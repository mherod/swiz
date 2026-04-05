# Stop-Completion-Auditor Extraction Plan

**Target**: Modularize stop-completion-auditor.ts into separable validation layers using the stop-pr-feedback/stop-ship-checklist extraction pattern.

## Current Monolithic Structure

**File**: `hooks/stop-completion-auditor.ts` (~350 lines)

**Four Combined Validation Layers**:

1. **Task Creation Enforcement** (TOOL_CALL_THRESHOLD check)
   - Verifies minimum tool call count before tasks can complete
   - Prevents premature task completion

2. **Audit Log Validation** (checkAuditLogAllowsStop)
   - Falls back to audit log when no live task files exist
   - Extracts session history from sibling sessions
   - Validates task status transitions

3. **CI Evidence Enforcement** (enforceCiEvidence)
   - Requires proof of CI success (green/pass/success)
   - Checks task completion evidence and subject lines
   - Blocks stop if push occurred but no CI evidence exists

4. **Task Reconciliation** (runStopCompletionWhenTasksDirReady)
   - Waits for task directory to be ready
   - Reads fresh task files from disk
   - Orchestrates all validation layers

## Target Modular Structure

```
hooks/
├── stop-completion-auditor.ts              # Main hook entry (SwizStopHook)
└── stop-completion-auditor/
    ├── types.ts                            # Domain interfaces
    ├── context.ts                          # Settings and prerequisites
    ├── task-creation-validator.ts          # Tool call threshold enforcement
    ├── audit-log-validator.ts              # Audit log fallback validation
    ├── ci-evidence-validator.ts            # CI evidence requirement checking
    ├── task-reconciliation.ts              # Task state reconciliation
    ├── action-plan.ts                      # Unified action plan generation
    └── evaluate.ts                         # Main orchestration
```

## Module Responsibilities

### types.ts
```typescript
interface CompletionValidationGate {
  taskCreation: boolean
  auditLog: boolean
  ciEvidence: boolean
}

interface ValidationResult {
  kind: 'task-creation' | 'audit-log' | 'ci-evidence' | 'ok'
  reason?: string
  planSteps?: ActionPlanItem[]
}

interface CompletionAuditContext {
  cwd: string
  sessionId: string | undefined
  tasksDir: string
  gates: CompletionValidationGate
  toolCallCount: number
  observedToolNames: string[]
  taskToolUsed: boolean
}
```

### context.ts
- Resolve task directory and prerequisites
- Load settings for validation gates
- Fail-open: return null if not applicable

### task-creation-validator.ts
- Check tool call count against TOOL_CALL_THRESHOLD (10)
- Validate minimum usage before task completion allowed
- Return null if threshold not met

### audit-log-validator.ts
- Fall back to audit log when no task files exist
- Extract sibling session IDs from project directory
- Validate task status transitions from audit entries
- Query audit log for completion evidence

### ci-evidence-validator.ts
- Check if push occurred in this session
- Require CI evidence (green/pass/success) in task completion evidence
- Validate using CI_EVIDENCE_RE regex
- Block if push happened but no CI evidence found

### task-reconciliation.ts
- Read fresh task files from disk
- Wait for task directory readiness
- Handle stale task state reconciliation
- Coordinate with other validators

### action-plan.ts
- Build unified action plan from all validation failures
- Order by priority: task-creation → audit-log → ci-evidence
- Generate messaging for each validation layer

### evaluate.ts
- Orchestrate all 4 validators in parallel
- Unify results into single SwizHookOutput
- Fail-open: returns null/empty on errors

## Implementation Challenges

### 1. **Audit Log Complexity**
- Need to parse and validate historical audit entries
- Sibling session discovery requires project directory traversal
- Handle stale/missing audit logs gracefully

### 2. **Task State Reconciliation**
- Coordinate with task-state-cache.ts and task-recovery.ts
- Handle cases where no task files exist yet
- Manage timing between task directory creation and validation

### 3. **CI Evidence Detection**
- Regex CI_EVIDENCE_RE must match variants (green, pass, success, conclusion: success)
- Check both completionEvidence and subject fields
- Don't over-match non-CI references

### 4. **Settings Integration**
- Determine which validation gates are enabled
- May need settings like `taskCreationGate`, `auditLogGate`, `ciEvidenceGate`
- Fail-open when prerequisites missing

## Testing Strategy

### Unit Tests
- Task creation threshold validation
- Audit log entry parsing and validation
- CI evidence regex and field checking
- Sibling session discovery

### Integration Tests
- All 4 validators working together
- Validation ordering and priority
- Fallback to audit log when task files missing
- Settings integration (gates enabled/disabled)

### Production Scenarios
- All validators blocking (task creation + audit + CI evidence)
- Partial validators blocking (only CI evidence missing)
- No validators blocking (all valid)
- Task directory not ready yet (wait and retry)

## Performance Targets

- Cached state: <200ms
- Audit log cold read: <500ms
- Combined worst-case: <2s (with audit log + sibling lookup)

## Commit Sequence

1. Extract types and context
2. Extract task-creation-validator
3. Extract audit-log-validator
4. Extract ci-evidence-validator
5. Extract task-reconciliation
6. Extract action-plan
7. Extract evaluate and refactor main hook
8. Add comprehensive tests

## Key Reusable Patterns from stop-ship-checklist

- **Composition**: Reuse existing helpers (readSessionTasks, readSessionTasksFresh)
- **Fail-open**: Return null at every validation layer
- **Unified output ordering**: Priority ordering (creation → audit → ci)
- **Parallel validation**: Validators can run in parallel with Promise.all()
- **Caching**: Store validation results to avoid redundant disk/API calls

## Next Steps

1. Begin extraction with types.ts and context.ts
2. Extract validators in order of complexity
3. Add comprehensive test suite (unit + integration + production)
4. Update README with stop-completion-auditor documentation
5. Verify manifest ordering (should run after all task work is done)
6. Gather feedback on pattern refinement

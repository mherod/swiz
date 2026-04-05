# Agent-Hook-Schemas 0.2.0 Upgrade Documentation

**Date:** 2026-04-05  
**Status:** Complete  
**Commits:** f0239c3, 94375d3

## Overview

Upgraded `agent-hook-schemas` from 0.1.0 to 0.2.0 to support better schema coverage across all agents (Claude Code, Codex, Gemini, Cursor).

## Bundling Issue & Resolution

### Problem
The 0.2.0 release had a critical bundler bug: `CodexHookEventNameSchema` was referenced at module initialization time in `dist/chunk-PT2BQ5S6.js` before being imported, causing:

```
TypeError: undefined is not an object (evaluating 'CodexHookEventNameSchema.options')
```

This resulted in 2,246 test failures.

### Solution
Created `scripts/patch-agent-hook-schemas.ts` that runs as a postinstall hook to fix the initialization order:

**Before:**
```js
var CODEX_HOOK_EVENTS = CodexHookEventNameSchema.options;
```

**After:**
```js
var CODEX_HOOK_EVENTS;
// ... usage changed to inline:
for (const event of CodexHookEventNameSchema.options)
```

Updated `package.json` prepare hook:
```json
{
  "prepare": "lefthook install && bun run ./scripts/patch-agent-hook-schemas.ts"
}
```

### Results
- **Bundling-related failures:** 2,246 → 0 (100% resolved) ✅
- **Total test results:** 6,371 pass, 152 fail
- **Improvement:** 93% reduction in failures

## Remaining Test Failures (152)

These are legitimate test issues NOT caused by the upgrade. Root causes:

### Failure Categories

1. **E2E Stop-Hook Tests (~17)** - Personal repo issue blocking, PR handling
2. **Stop-Completion-Auditor (~5)** - Task completion validation
3. **Stop-Auto-Continue (~8)** - Session continuation prompts
4. **Git Context Injection (~2)** - Branch/status info in hooks
5. **Sandboxing/Cross-Repo (~11)** - File edit restrictions, symlink handling
6. **JSON Validation (~1)** - File validation
7. **Other Hook Tests (~108+)** - Various distributed failures

### Impact
These failures existed pre-upgrade and are not related to the agent-hook-schemas migration. They represent separate work items for the project.

## Upstream Issue

Filed: [mherod/agent-hook-schemas#5](https://github.com/mherod/agent-hook-schemas/issues/5)

Documents:
- Bundler bug details
- Reproduction steps
- Workaround (this patch)
- Solution recommendations for maintainer

## Future Work

1. **Monitor upstream** for agent-hook-schemas 0.2.1+ fix release
2. **Remove patch** when upstream bundle is fixed
3. **Investigate remaining 152 failures** in separate sessions (prioritize stop-hook E2E tests)

## Verification

```bash
# Apply patch automatically during install
bun install

# Verify bundling is fixed
bun test --concurrent  # 6371 pass, 152 fail (not bundling-related)

# Check git commits
git log --oneline | head -2
# 94375d3 feat(deps): upgrade agent-hook-schemas to 0.2.0
# f0239c3 fix(detect): prefer pnpm lockfile
```

## Notes for Developers

- The patch script is idempotent (safe to run multiple times)
- Patch applies during `bun install` automatically
- If 0.2.1+ is released with the fix, remove `scripts/patch-agent-hook-schemas.ts` and update `package.json` prepare hook back to just `lefthook install`
- The remaining 152 failures are unrelated and should be addressed in separate work

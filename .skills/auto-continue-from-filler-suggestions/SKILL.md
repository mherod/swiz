---
name: auto-continue-from-filler-suggestions
description: Generate deterministic next-step suggestions based on git state, task state, and edited files — no AI backend required.
category: workflow
---

# Auto-Continue from Filler Suggestions

Generate a deterministic next-step suggestion without requiring an AI backend. Uses git status, task completion state, and session context to produce actionable guidance.

## When to Use

- When the AI-powered auto-continue suggestion fails or is unavailable
- When you need a quick, deterministic "what should I do next?" without waiting for an API call
- As a fallback when `GEMINI_API_KEY` is not configured

## How It Works

The filler-suggestions module (`hooks/stop-auto-continue/filler-suggestions.ts`) checks these signals in priority order:

1. **Uncommitted changes** — If dirty files exist, suggest `/commit`
2. **Unpushed commits** — If local commits are ahead of remote, suggest `/push`
3. **Incomplete tasks** — If session tasks remain, suggest completing them
4. **Edited file patterns** — If hooks were edited without tests, suggest running tests; if many files changed, suggest review

## Usage

Run the filler suggestion builder directly:

```bash
bun -e "
import { buildFillerSuggestion } from './hooks/stop-auto-continue/filler-suggestions.ts';
const result = await buildFillerSuggestion({ cwd: process.cwd() });
console.log(result || 'No suggestion — session is clean.');
"
```

## Integration

This module is integrated at two levels in `hooks/stop-auto-continue.ts`:

1. **Primary fallback** — When no AI backend is available (`!hasAiProvider()`), filler suggestions are used directly instead of blocking with an API key error. If a filler suggestion exists, it blocks the stop with actionable guidance. If no suggestion can be generated, the stop is allowed gracefully.

2. **Error fallback** — When the AI backend call fails (network error, model not found, etc.), filler suggestions are tried before allowing the stop.

To extend the suggestion logic, edit `hooks/stop-auto-continue/filler-suggestions.ts` and add new priority levels to `buildFillerSuggestion()`.

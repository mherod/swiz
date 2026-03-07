---
description: Configure swiz settings with presets or individual changes. Examples: "backlog worker", "creative mode", "quiet mode", "lockdown", "enable speak"
allowed-tools: Bash
argument-hint: "<preset | setting-change> [--global | --project | --session [id]]"
---

Configure swiz settings using presets or individual changes.

## Presets

Parse `$ARGUMENTS` for a preset keyword and run the corresponding commands:

### Workflow presets

| Preset | Commands | Description |
|--------|----------|-------------|
| `backlog` | `enable auto-continue` + `set ambition-mode aggressive` + `set collaboration-mode solo` + `enable personal-repo-issues-gate` + `enable git-status-gate` + `enable github-ci-gate` | Autonomous backlog worker — picks up issues, implements, commits, pushes, and moves to the next one |
| `creative` | `enable auto-continue` + `set ambition-mode creative` | Auto-continue with creative issue drafting |
| `aggressive` | `enable auto-continue` + `set ambition-mode aggressive` | Auto-continue focused on biggest missing capability |
| `reflective` | `enable auto-continue` + `set ambition-mode reflective` | Auto-continue driven by session reflections |
| `standard` | `enable auto-continue` + `set ambition-mode standard` | Auto-continue with balanced suggestions |
| `quiet` | `disable auto-continue` + `disable critiques-enabled` | No auto-continue, no critiques |
| `loud` | `enable auto-continue` + `enable critiques-enabled` + `enable speak` | Full auto-continue with critiques and TTS |
| `interactive` | `disable auto-continue` + `enable critiques-enabled` | Manual mode with quality feedback |

### Collaboration presets

| Preset | Commands | Description |
|--------|----------|-------------|
| `solo` | `set collaboration-mode solo` | Direct push to main, no PRs |
| `team` | `set collaboration-mode team` | Require PRs for all changes |

### Safety presets

| Preset | Commands | Description |
|--------|----------|-------------|
| `lockdown` | `enable sandboxed-edits` + `enable push-gate` + `enable git-status-gate` + `enable github-ci-gate` + `enable changes-requested-gate` + `enable non-default-branch-gate` | All safety gates enabled — maximum guardrails |
| `relaxed` | `disable push-gate` + `disable non-default-branch-gate` + `disable changes-requested-gate` | Fewer gates — trust the developer |

## Individual settings

If `$ARGUMENTS` does not match a preset, pass it directly to `swiz settings`:
- `swiz settings $ARGUMENTS`

## Scope flags

If `$ARGUMENTS` contains `--global`, `--project`, or `--session`, append that flag to every command.

## Rules

1. Prefix each command with `swiz settings` (e.g., `swiz settings enable auto-continue`).
2. Run the matching commands sequentially.
3. After all commands, run `swiz settings` to show the resulting state.
4. Summarize what changed in one sentence.

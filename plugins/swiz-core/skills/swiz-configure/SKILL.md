---
description: Configure swiz settings with presets or individual changes. Examples: "creative mode", "aggressive auto-continue", "quiet mode", "enable speak", "disable critiques"
allowed-tools: Bash
argument-hint: "<preset | setting-change> [--global | --project | --session [id]]"
---

Configure swiz settings using presets or individual changes.

## Presets

Parse `$ARGUMENTS` for a preset keyword and run the corresponding commands:

| Preset | Commands | Description |
|--------|----------|-------------|
| `creative` | `swiz settings enable auto-continue` + `swiz settings set ambition-mode creative` | Auto-continue with creative issue drafting |
| `aggressive` | `swiz settings enable auto-continue` + `swiz settings set ambition-mode aggressive` | Auto-continue focused on biggest missing capability |
| `reflective` | `swiz settings enable auto-continue` + `swiz settings set ambition-mode reflective` | Auto-continue driven by session reflections |
| `standard` | `swiz settings enable auto-continue` + `swiz settings set ambition-mode standard` | Auto-continue with balanced suggestions |
| `quiet` | `swiz settings disable auto-continue` + `swiz settings disable critiques-enabled` | No auto-continue, no critiques |
| `loud` | `swiz settings enable auto-continue` + `swiz settings enable critiques-enabled` + `swiz settings enable speak` | Full auto-continue with critiques and TTS |
| `solo` | `swiz settings set collaboration-mode solo` | Direct push to main, no PRs |
| `team` | `swiz settings set collaboration-mode team` | Require PRs for all changes |

## Individual settings

If `$ARGUMENTS` does not match a preset, pass it directly to `swiz settings`:
- `swiz settings $ARGUMENTS`

## Scope flags

If `$ARGUMENTS` contains `--global`, `--project`, or `--session`, append that flag to every command.

## Rules

1. Run the matching commands sequentially.
2. After all commands, run `swiz settings` to show the resulting state.
3. Summarize what changed in one sentence.

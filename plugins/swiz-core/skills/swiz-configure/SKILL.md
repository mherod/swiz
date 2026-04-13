---
name: swiz-configure
description: "Configure swiz settings with presets or individual changes. Supports workflow presets (backlog, creative, quiet), collaboration modes (solo, team), and safety presets (lockdown, relaxed). Use when changing agent behavior, switching workflow modes, or adjusting safety gates."
category: configuration
metadata:
  allowed-tools: Bash
  argument-hint: "<preset | setting-change> [--global | --project | --session [id]]"
---

Configure swiz settings using presets or individual changes. Parses `$ARGUMENTS` to match a preset keyword or passes raw settings to `swiz settings`.

## Usage

- `/swiz-configure backlog` — autonomous backlog worker mode
- `/swiz-configure quiet` — disable auto-continue and critiques
- `/swiz-configure solo --global` — set solo collaboration globally
- `/swiz-configure enable speak` — pass individual setting directly

## Presets

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
| `team` | `set collaboration-mode team` | Require PRs + peer review for all changes |
| `relaxed-collab` | `set collaboration-mode relaxed-collab` | Feature branches + PRs, self-review is sufficient |

### Safety presets

| Preset | Commands | Description |
|--------|----------|-------------|
| `lockdown` | `enable sandboxed-edits` + `enable push-gate` + `enable git-status-gate` + `enable github-ci-gate` + `enable changes-requested-gate` + `enable non-default-branch-gate` | All safety gates enabled — maximum guardrails |
| `relaxed` | `disable push-gate` + `disable non-default-branch-gate` + `disable changes-requested-gate` | Fewer gates — trust the developer |

## Step 1: Parse Arguments

Check if `$ARGUMENTS` matches a preset keyword from the tables above.

## Step 2: Execute Commands

**If preset matched:** Run all commands for that preset sequentially, each prefixed with `swiz settings`.

**If no preset matched:** Pass `$ARGUMENTS` directly to `swiz settings $ARGUMENTS`.

## Step 3: Apply Scope

If `$ARGUMENTS` contains `--global`, `--project`, or `--session`, append that flag to every command.

## Step 4: Confirm State

Run `swiz settings` to show the resulting state and summarize what changed in one sentence.

## Failure Handling

**If preset keyword is ambiguous:** List matching presets and ask the user to clarify.

**If `swiz settings` command fails:** Report the error and suggest checking `swiz settings --help` for valid options.

---
name: disable-auto-continue
description: "Disable swiz auto-continue globally or for a specific session. Stops the agent from automatically continuing after task completion. Use when switching to manual mode, pausing autonomous work, or scoping auto-continue to a specific session."
category: configuration
metadata:
  allowed-tools: Bash
  argument-hint: "[--session [id] --dir <path>]"
---

Disable auto-continue by running the swiz settings command. Supports global or session-scoped disabling.

## Usage

- `/disable-auto-continue` — disable globally
- `/disable-auto-continue --session` — disable for the current session only
- `/disable-auto-continue --session abc123 --dir /path/to/project` — disable for a specific session and directory

## Step 1: Run the Command

**If `$ARGUMENTS` is empty:** Run `swiz settings disable auto-continue`.

**If `$ARGUMENTS` is present:** Run `swiz settings disable auto-continue $ARGUMENTS`.

## Step 2: Confirm

Summarize the resulting state — confirm auto-continue is now disabled and at what scope (global or session).

## Failure Handling

**If the command fails:** Report the error output and suggest checking `swiz settings --help`.

---
name: enable-auto-continue
description: "Enable swiz auto-continue globally or for a specific session. Allows the agent to automatically continue working after task completion. Use when starting autonomous workflows, enabling backlog processing, or scoping auto-continue to a specific session."
category: configuration
metadata:
  allowed-tools: Bash
  argument-hint: "[--session [id] --dir <path>]"
---

Enable auto-continue by running the swiz settings command. Supports global or session-scoped enabling.

## Usage

- `/enable-auto-continue` — enable globally
- `/enable-auto-continue --session` — enable for the current session only
- `/enable-auto-continue --session abc123 --dir /path/to/project` — enable for a specific session and directory

## Step 1: Run the Command

**If `$ARGUMENTS` is empty:** Run `swiz settings enable auto-continue`.

**If `$ARGUMENTS` is present:** Run `swiz settings enable auto-continue $ARGUMENTS`.

## Step 2: Confirm

Summarize the resulting state — confirm auto-continue is now enabled and at what scope (global or session).

## Failure Handling

**If the command fails:** Report the error output and suggest checking `swiz settings --help`.

---
name: enable-auto-continue
description: "Enable swiz auto-continue globally or for a specific session. Allows the agent to automatically continue working after task completion. Use when starting autonomous workflows, enabling backlog processing, or scoping auto-continue to a specific session."
category: configuration
metadata:
  argument-hint: "[--session [id] --dir <path>]"
---

Use the current host's available shell tool. Arguments are the options requested by the user; substitute them for `<arguments>` in examples, never pass the placeholder literally. Respect explicit user instructions over this workflow. If `swiz` is missing, explain the Bun and linked CLI prerequisites in the plugin README.

Enable auto-continue by running the swiz settings command. Supports global or session-scoped enabling.

## Usage

- `/enable-auto-continue` — enable globally
- `/enable-auto-continue --session` — enable for the current session only
- `/enable-auto-continue --session abc123 --dir /path/to/project` — enable for a specific session and directory

## Step 1: Run the Command

**If no arguments were requested:** Run `swiz settings enable auto-continue`.

**If arguments were requested:** Run `swiz settings enable auto-continue <arguments>`.

## Step 2: Confirm

Summarize the resulting state — confirm auto-continue is now enabled and at what scope (global or session).

## Failure Handling

**If the command fails:** Report the error output and suggest checking `swiz settings --help`.

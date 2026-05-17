---
name: swiz-cleanup
description: "Run swiz cleanup to remove stale hook configurations, orphaned dispatch entries, and temporary files. Use when hooks are out of sync, after uninstalling plugins, or when swiz state needs a reset."
category: maintenance
metadata:
  allowed-tools: Bash
  argument-hint: "[arguments]"
---

Run the swiz `cleanup` command to remove stale configurations and restore a clean state.

## Usage

- `/swiz-cleanup` — run default cleanup
- `/swiz-cleanup --dry-run` — preview what would be removed without making changes

## Step 1: Run the Command

**If `$ARGUMENTS` is empty:** Run `swiz cleanup`.

**If `$ARGUMENTS` is present:** Run `swiz cleanup $ARGUMENTS`.

## Step 2: Report Results

Summarize key output: what was cleaned up, how many items removed, and report any errors clearly.

## Failure Handling

**If cleanup reports errors:** Display the full error output and suggest running `swiz status` to diagnose the issue.

**If nothing to clean:** Report that the environment is already clean.

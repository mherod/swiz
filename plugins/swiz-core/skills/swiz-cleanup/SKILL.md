---
name: swiz-cleanup
description: "Run swiz doctor clean to remove old session data, archives, and backups. Use when the user requests session cleanup or wants to preview disk cleanup."
category: maintenance
metadata:
  argument-hint: "[arguments]"
---

Use the current host's available shell tool. Arguments are the options requested by the user; substitute them for `<arguments>` in examples, never pass the placeholder literally. Respect explicit user instructions over this workflow. If `swiz` is missing, explain the Bun and linked CLI prerequisites in the plugin README.

Run `swiz doctor clean` to clean old session data. It does not repair hook registrations.

## Usage

- `/swiz-cleanup` — run default cleanup
- `/swiz-cleanup --dry-run` — preview what would be removed without making changes

## Step 1: Run the Command

**If no arguments were requested:** Run `swiz doctor clean`.

**If arguments were requested:** Run `swiz doctor clean <arguments>`.

## Step 2: Report Results

Summarize key output: what was cleaned up, how many items removed, and report any errors clearly.

## Failure Handling

**If cleanup reports errors:** Display the full error output and suggest running `swiz status` to diagnose the issue.

**If nothing to clean:** Report that the environment is already clean.

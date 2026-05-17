---
name: swiz-continue
description: "Run swiz continue to resume the agent's self-directed loop. Picks up the next task from the backlog or generates a new one based on ambition mode. Use when resuming autonomous work, continuing after a pause, or triggering the next iteration of the agent loop."
category: workflow
metadata:
  allowed-tools: Bash
  argument-hint: "[arguments]"
---

Run the swiz `continue` command to resume or advance the self-directed agent loop.

## Usage

- `/swiz-continue` — resume the default continue flow
- `/swiz-continue --pick-issue` — pick a specific issue to work on next

## Step 1: Run the Command

**If `$ARGUMENTS` is empty:** Run `swiz continue`.

**If `$ARGUMENTS` is present:** Run `swiz continue $ARGUMENTS`.

## Step 2: Report Results

Summarize key output: what task was selected, what the agent will work on next, and report any errors clearly.

## Failure Handling

**If continue fails:** Report the error and suggest checking `swiz status` for the current agent state.

**If no tasks available:** Report that the backlog is empty and suggest using `swiz idea` to generate new work items.

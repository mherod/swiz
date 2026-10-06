---
name: swiz-continue
description: "Run swiz continue to resume the agent's self-directed loop. Picks up the next task from the backlog or generates a new one based on ambition mode. Use when resuming autonomous work, continuing after a pause, or triggering the next iteration of the agent loop."
category: workflow
metadata:
  argument-hint: "[arguments]"
---

Use the current host's available shell tool. Arguments are the options requested by the user; substitute them for `<arguments>` in examples, never pass the placeholder literally. Respect explicit user instructions over this workflow. If `swiz` is missing, explain the Bun and linked CLI prerequisites in the plugin README.

Run the swiz `continue` command to resume or advance the self-directed agent loop.

## Usage

- `/swiz-continue` — resume the default continue flow
- `/swiz-continue --print` — preview the suggested next step without resuming

## Step 1: Run the Command

**If no arguments were requested:** Run `swiz continue`.

**If arguments were requested:** Run `swiz continue <arguments>`.

## Step 2: Report Results

Summarize key output: what task was selected, what the agent will work on next, and report any errors clearly.

## Failure Handling

**If continue fails:** Report the error and suggest checking `swiz status` for the current agent state.

**If no tasks available:** Report that the backlog is empty and suggest using `swiz idea` to generate new work items.

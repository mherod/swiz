---
name: git-graph
description: Visualize git branch history as an ASCII graph. Shows branch topology, merge points, tags, and recent commit messages. Use when orienting to branch structure, reviewing merge history, or understanding divergence points.
metadata:
  argument-hint: "[limit=30] [branch=--all]"
---

Render the git branch graph for the current repository and explain the topology: active branches, merge points, divergences, and tags.

## Usage

- `/git-graph` (defaults: last 30 commits, all branches)
- `/git-graph 50` (last 50 commits)
- `/git-graph 20 main` (last 20 commits on main only)

## Context

- Current directory: !`pwd`
- Current branch: !`git branch --show-current`
- Branch limit: !`echo "${1:-30}"`
- Branch filter: !`echo "${2:---all}"`
- Graph: !`git log --graph --oneline --decorate ${2:---all} -${1:-30} 2>/dev/null`
- All local branches: !`git branch -v 2>/dev/null`
- Remote tracking branches: !`git branch -rv 2>/dev/null | head -20`
- Tags (recent): !`git tag --sort=-creatordate 2>/dev/null | head -10`
- Unpushed commits: !`git log origin/$(git branch --show-current)..HEAD --oneline 2>/dev/null || echo "(no upstream)"`

## Your Task

Present the branch graph clearly and annotate key topology features.

**DO:**
- Display the raw graph output from Context verbatim in a code block first
- Identify the current HEAD position and active branch
- Call out merge commits and what branches they merged
- Highlight divergence points (where branches split from a common ancestor)
- Note any tags and what they mark
- Flag unpushed commits on the current branch
- Identify long-running branches vs short-lived feature branches
- Note if the graph shows clean linear history vs complex merge topology

**DO NOT:**
- Re-run git commands already provided in Context — use the captured output
- Invent commit details not visible in the graph
- Skip the raw graph — always show it first so the user can read it directly

## Step 1: Display the Raw Graph

Render the graph from Context in a fenced code block.

## Step 2: Annotate Topology

### Current State
- **HEAD**: [branch name] at [short hash]
- **Unpushed**: [count] commit(s) or "up to date"

### Branch Structure
| Branch | Last commit | Status |
|--------|-------------|--------|
| main | [hash] [message] | [ahead/behind/current] |

### Merge History
List merge commits found in the graph range, what they merged, and when.

### Divergence Points
Identify where branches split from their common ancestor.

### Tags
List any tags visible in the range with their commit context.

### Topology Summary
One paragraph: branching style, merge frequency, notable patterns.

## Failure Handling

**If the repository has no commits:** Report "Empty repository — no commits yet."

**If no remote tracking info:** Note "(no remote configured)" for upstream comparisons.

**If graph is very wide:** Suggest running `/git-graph 10 main` to narrow scope, then show the full graph anyway.

## Related Skills (Direct Handoffs)

- Use `git-log-bisect/SKILL.md` when the task shifts to analyzing what specific commits changed and their behavioural effects.
- Use `prune-branches/SKILL.md` when the task shifts to identifying and cleaning up stale branches.
- Use `changelog/SKILL.md` when the task shifts to generating a changelog from recent git history.

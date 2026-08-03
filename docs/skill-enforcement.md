# Hook-Enforced Skills

Verified against source on 2026-08-02. This document distinguishes hooks that verify a
skill invocation or `SKILL.md` read from hooks that only recommend a skill while enforcing
some other outcome.

## Quick reference

Swiz has **12 invocation-gated skills that apply to Codex** and **4 additional stop-gated
skills for agents with a native `Skill` tool**.

### Invocation gates active for Codex

| Skill | Trigger | Enforcement hook |
|---|---|---|
| `commit` | A shell command matching `git commit`. A recent task-list read is also required when the agent exposes task tools. | `hooks/pretooluse-skill-invocation-gate.ts` |
| `push` | A shell command matching `git push`, except branch deletion. An active task named `Push #N` also blocks edits and shell commands until the workflow starts. | `hooks/pretooluse-skill-invocation-gate.ts`; `hooks/pretooluse-issue-workflow-gate.ts` |
| `triage-issues` | `gh issue edit ... --add-label triaged`. | `hooks/pretooluse-skill-invocation-gate.ts` |
| `refine-issue` | Any existing-issue label addition or removal. | `hooks/pretooluse-skill-invocation-gate.ts` |
| `work-on-issue` | Self-assignment with `gh issue edit ... --add-assignee @me`; one accepted workflow for `gh pr checkout`; or an active task named `Work on issue #N`. | `hooks/pretooluse-skill-invocation-gate.ts`; `hooks/pretooluse-issue-workflow-gate.ts` |
| `pr-open` | `gh pr create`. | `hooks/pretooluse-skill-invocation-gate.ts` |
| `pr-qa-and-merge` | Any command accepted by `isPullRequestMergeCommand()`, including native `gh pr merge`, REST `PUT .../pulls/{number}/merge`, and GraphQL `mergePullRequest`, `enablePullRequestAutoMerge`, or `enqueuePullRequest`. It is also one accepted workflow for `gh pr checkout`. | `hooks/pretooluse-skill-invocation-gate.ts`; `src/utils/git-utils.ts` |
| `pr-comments-address` | `gh pr review ... --dismiss`; reads of `/pulls/N/comments` or `/pulls/N/reviews` while on a non-default branch with an open PR; or one accepted workflow for `gh pr checkout`. | `hooks/pretooluse-skill-invocation-gate.ts`; `hooks/pretooluse-pr-comment-read-gate.ts` |
| `update-memory` | Edits to `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, or `.cursorrules`. After a memory-capture reminder, normal work can also be blocked until `update-memory/SKILL.md` has been read and a Markdown file has been written. | `hooks/pretooluse-claude-md-update-memory-gate.ts`; `hooks/pretooluse-update-memory-enforcement.ts` |
| `generate-requirements` | Edits to `REQUIREMENTS.md`. | `hooks/pretooluse-requirements-generate-gate.ts` |
| `apply-rsc` | Edits to nested App Router `app/**/page.tsx` files, any `layout.tsx`, App Router `error.tsx` or `loading.tsx`, and colocated `*-client.tsx` files under `app/`. The current page matcher requires at least one directory between `app/` and `page.tsx`. | `hooks/pretooluse-apply-rsc-gate.ts` |
| `convert-to-kotlin` | Editing Java, or creating a Kotlin counterpart for neighbouring Java, when both Gradle and Kotlin are detected. | `hooks/pretooluse-require-convert-to-kotlin.ts` |

Codex is explicitly supported by the filesystem-backed skill lookup: a direct read of an
installed `SKILL.md` counts as usage even though Codex has no native `Skill` tool
(`src/skill-utils.ts`, `skillExistsForHookPayload`). All 12 skills above are installed in the
current Codex skill directories.

### Native-`Skill`-tool stop gates

`hooks/stop-required-skills.ts` evaluates these rules in order and blocks on the first
applicable missing invocation:

| Skill | Stop condition |
|---|---|
| `end-of-day` | `enforceEndOfDay` is enabled and the repository has unpushed commits or incomplete session tasks. |
| `farm-out-issues` | The session is in a Git repository. An older invocation remains valid when no commit or push occurred after it. |
| `continue-with-tasks` | Required before stop after earlier applicable rules have passed. |
| `reflect-on-session-mistakes` | Required before stop after earlier applicable rules have passed. |

These four rules intentionally fail open for agents without a native `Skill` tool, including
Codex (`agentHasSkillToolForHookPayload`). They are therefore present in the hook policy but
are not currently enforced in Codex sessions.

## Gate-skill drift detection

`src/gate-required-skills.ts` is the canonical registry for all 16 skill names whose absence
can make an enforcement decision fail open. The central command gate, specialized file and
PR-comment gates, memory follow-through gate, and ordered Stop rules consume those entries
instead of owning duplicate skill-name strings.

`swiz doctor` runs the `Gate-required skills` check against the same filesystem-backed
`skillFileExists()` lookup used by runtime gates. A missing entry is reported with its owning
hook so maintainers can install the skill or remove the stale gate rule before fail-open turns
into fail-always. Advisory-only skill references are intentionally outside this registry because
their underlying policy still runs when the suggested skill is unavailable.

## Enforcement strength and fail-open behaviour

### Central shell-command gate is prompt-once

`hooks/pretooluse-skill-invocation-gate.ts` does not provide strict, permanent enforcement:

1. It blocks the first matching command when no recent invocation is found.
2. It writes a per-session, per-agent, per-skill cooldown for 2 minutes.
3. A retry during that cooldown returns an empty allow response even if the skill remains
   unread.

Consequently, `commit`, `push`, `triage-issues`, `refine-issue`, `work-on-issue`, `pr-open`,
`pr-qa-and-merge`, and the review-dismiss portion of `pr-comments-address` are advisory
one-shot blocks rather than unbypassable requirements.

The central gate also fails open when the required skill is not installed or no transcript
path is available. A valid invocation must otherwise fall inside the configured recency
window (`skillRecencyMaxTurns` and `skillRecencyMaxAgeMinutes`).

### Specialized file and PR-comment gates

The `generate-requirements`, `apply-rsc`, `convert-to-kotlin`, memory-file, and PR-comment-read
gates re-check invocation on each matching call and do not use the central gate's 2-minute
cooldown. They still fail open when the skill is unavailable, the transcript is unavailable,
or their project/file/branch preconditions do not apply.

`pretooluse-update-memory-enforcement.ts` is a separate reminder-follow-through gate. It
specifically looks for a read containing `update-memory/SKILL.md` plus a later Markdown write,
but the hook itself has a 300-second dispatch cooldown and several skip conditions: recent
memory modification, an active task, post-trigger compaction, a non-git directory, or no
`CLAUDE.md` in the project tree.

## Skill-backed hooks that do not verify invocation

The following skills appear in blocking or advisory hook messages, but the hook clears when
the underlying state is corrected; it does not require proof that the named skill ran:

| Skill | State or advice using it |
|---|---|
| `compact-memory` | Oversized `CLAUDE.md`/`MEMORY.md` files and projected word-limit violations. |
| `rebase-onto-main` | Branch conflicts, stale branches, and conflict-only PR comments. |
| `resolve-conflicts` | Behind-upstream and merge-conflict remediation. |
| `pr-salvage` | Recovery for branches too stale to rebase safely. |
| `refine-pr` | Thin or missing pull-request descriptions. |
| `prune-branches` | Excess remote branches at stop. |
| `gdpr-analysis` | Data-model changes with privacy implications. |
| `pr-request-changes` | Pull requests awaiting actionable review. |
| `work-on-prs` | Routing to a linked PR or aligning with its head branch; branch checkout can satisfy the same gate. |

Other occurrences such as `morning-standup`, `weekly-retro`, `changelog`, `delete-safely`, and
auto-continue suggestions are prompts only and are not skill-invocation enforcement.

## Authoritative sources

- Fail-open gate skill names and owning hooks: `GATE_REQUIRED_SKILLS` in
  [`gate-required-skills.ts`](../src/gate-required-skills.ts).
- Central command-to-skill mapping: `classifyRequiredSkill()` in
  [`pretooluse-skill-invocation-gate.ts`](../hooks/pretooluse-skill-invocation-gate.ts).
- PR merge command recognition: `isPullRequestMergeCommand()` in
  [`git-utils.ts`](../src/utils/git-utils.ts).
- Codex skill-read recognition and recency resolution: [`skill-utils.ts`](../src/skill-utils.ts)
  and [`skill-usage.ts`](../src/skill-usage.ts).
- Specialized invocation gates: [`pretooluse-claude-md-update-memory-gate.ts`](../hooks/pretooluse-claude-md-update-memory-gate.ts),
  [`pretooluse-requirements-generate-gate.ts`](../hooks/pretooluse-requirements-generate-gate.ts),
  [`pretooluse-apply-rsc-gate.ts`](../hooks/pretooluse-apply-rsc-gate.ts),
  [`pretooluse-require-convert-to-kotlin.ts`](../hooks/pretooluse-require-convert-to-kotlin.ts),
  [`pretooluse-pr-comment-read-gate.ts`](../hooks/pretooluse-pr-comment-read-gate.ts), and
  [`pretooluse-update-memory-enforcement.ts`](../hooks/pretooluse-update-memory-enforcement.ts).
- Ordered stop requirements: `REQUIRED_STOP_SKILLS` in
  [`stop-required-skills.ts`](../hooks/stop-required-skills.ts).
- Installed hook order: `bundledHookManifest` in [`manifest.ts`](../src/manifest.ts).

## Maintenance checklist

When adding or changing enforcement:

1. Register every new fail-open skill requirement in `GATE_REQUIRED_SKILLS`, including its owning
   hook, and consume that entry from the gate implementation.
2. Update the canonical classifier or the relevant specialized hook; do not duplicate command
   patterns in another gate.
3. Keep `SKILL_DENY_CONFIGS` synchronized with new central command mappings.
4. Add positive, negative, quoted-string, and agent-specific tests.
5. Verify Codex direct `SKILL.md` reads and native `Skill` invocations both satisfy the intended
   gate when supported.
6. Run `swiz doctor` and confirm `Gate-required skills` passes for the installed environment.
7. Update this document whenever a skill, trigger, cooldown, recency rule, or fail-open condition
   changes.

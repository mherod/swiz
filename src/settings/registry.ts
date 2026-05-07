import { z } from "zod"
import type { SettingDef } from "./types"
import { ambitionModeSchema, auditStrictnessSchema, collaborationModeSchema } from "./types"

export const SETTINGS_REGISTRY: SettingDef[] = [
  {
    key: "autoContinue",
    aliases: ["auto-continue", "autocontinue", "auto_continue"],
    kind: "boolean",
    scopes: ["global", "project", "session"],
    default: true,
    docs: {
      description: "Automatically continue after a stop event instead of waiting for user input",
      effectExplanation:
        "Controls whether the agent automatically resumes work after hitting a stop point. When disabled, the agent pauses and waits for you to manually continue.",
      enableDescription: "Enable stop auto-continue behavior",
      disableDescription: "Disable stop auto-continue behavior",
    },
  },
  {
    key: "prMergeMode",
    aliases: ["pr-merge-mode", "prmergemode", "pr_merge_mode", "pr-merge", "prmerge"],
    kind: "boolean",
    scopes: ["global", "session"],
    default: true,
    docs: {
      description:
        "Enable hooks that guide PRs toward merging (rebase, CI checks, review resolution)",
      effectExplanation:
        "When enabled, stop hooks check for unmerged PRs and prompt you to rebase, resolve reviews, and merge. When disabled, only PR creation guidance is active.",
      enableDescription: "Enable merge-oriented PR hooks",
      disableDescription: "Disable merge-oriented PR hooks; keep creation-oriented guidance only",
    },
  },
  {
    key: "critiquesEnabled",
    aliases: ["critiques-enabled", "critiquesenabled", "critiques_enabled", "critiques"],
    kind: "boolean",
    scopes: ["global"],
    default: true,
    docs: {
      description: "Include process/product critique feedback in auto-continue output",
      effectExplanation:
        "When enabled, auto-continue messages include critique lines evaluating process and product quality. When disabled, only the next-step directive is emitted.",
      enableDescription: "Show Process/Product critique lines in auto-continue output",
      disableDescription: "Suppress critique lines and emit only next-step directive",
    },
  },
  {
    key: "pushGate",
    aliases: ["push-gate", "pushgate", "push_gate"],
    kind: "boolean",
    scopes: ["global", "project"],
    default: false,
    docs: {
      description: "Block git push unless the user has explicitly approved it",
      effectExplanation:
        "When enabled, git push commands are blocked unless the user explicitly approves via /push, 'go ahead and push', or similar. Prevents the agent from pushing without consent.",
    },
  },
  {
    key: "skipSecretScan",
    aliases: ["skip-secret-scan", "skipsecretscan", "skip_secret_scan"],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
      description: "Skip scanning outgoing diffs for leaked secrets and credentials before push",
      effectExplanation:
        "When enabled, the push-checks-gate hook skips secret pattern detection. This removes the safety net that catches accidentally committed API keys, tokens, and passwords.",
      enableDescription: "Skip credential/secret pattern scan in push-checks-gate hook",
      disableDescription: "Scan outgoing diff for secrets and credentials before push",
    },
  },
  {
    key: "sandboxedEdits",
    aliases: ["sandboxed-edits", "sandboxededits", "sandboxed_edits"],
    kind: "boolean",
    scopes: ["global"],
    default: true,
    docs: {
      description: "Restrict file edits to the current working directory and /tmp only",
      effectExplanation:
        "When enabled, Edit/Write tool calls targeting files outside cwd and /tmp are blocked (with exemptions for well-known config files like .gitconfig, .npmrc). Disabling allows edits anywhere on the filesystem.",
      enableDescription: "Block file edits outside cwd and /tmp",
      disableDescription: "Allow file edits anywhere on the filesystem",
    },
  },
  {
    key: "speak",
    aliases: ["speak", "tts"],
    kind: "boolean",
    scopes: ["global", "project"],
    default: false,
    docs: {
      description: "Read agent output aloud using text-to-speech",
      effectExplanation:
        "When enabled, the agent's responses are spoken aloud via the TTS narrator. Configure voice with narrator-voice and speed with narrator-speed.",
      enableDescription: "Enable TTS narrator",
      disableDescription: "Disable TTS narrator",
    },
  },
  {
    key: "autoSteer",
    aliases: ["auto-steer", "autosteer", "auto_steer"],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
      description:
        "Automatically type 'Continue' into the terminal after each tool call (macOS only)",
      effectExplanation:
        "When enabled, uses AppleScript to simulate typing 'Continue' into your terminal after every tool call, creating a fully autonomous loop. Only works on macOS with accessibility permissions.",
      enableDescription: "Type 'Continue' into the terminal after every tool call via AppleScript",
      disableDescription: "Disable auto-steer terminal input",
    },
  },
  {
    key: "swizNotifyHooks",
    aliases: [
      "pseudo-hooks",
      "pseudohooks",
      "pseudo_hooks",
      "swiz-notify-hooks",
      "swiznotifyhooks",
      "swiz_notify_hooks",
      "transcript-pseudo-hooks",
    ],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
      description:
        "Allow transcript/session monitoring to synthesize pseudo-hook dispatches in the daemon",
      effectExplanation:
        "When enabled, the daemon may watch agent transcripts and emit pseudo hook events like postToolUse and notification for agents without native hook support. When disabled, transcript/session monitoring does not synthesize those hook dispatches.",
      enableDescription: "Enable transcript/session-monitoring powered pseudo hooks",
      disableDescription: "Disable transcript/session-monitoring powered pseudo hooks",
    },
  },
  {
    key: "autoSteerTranscriptWatching",
    aliases: [
      "auto-steer-transcript-watching",
      "autosteertranscriptwatching",
      "auto_steer_transcript_watching",
    ],
    kind: "boolean",
    scopes: ["global", "project"],
    default: false,
    docs: {
      description:
        "Enable daemon-driven auto-steering by monitoring session transcripts for tool calls",
      effectExplanation:
        "When enabled, the Swiz daemon monitors agent transcript files. When it detects a new tool call, it triggers the auto-steer hook logic even for agents that don't natively support hooks (like Cursor).",
      enableDescription: "Enable daemon-driven transcript monitoring for auto-steering",
      disableDescription: "Disable daemon-driven transcript monitoring for auto-steering",
    },
  },
  {
    key: "transcriptMonitorMaxConcurrentDispatches",
    aliases: [
      "transcript-monitor-max-concurrent-dispatches",
      "transcriptmonitormaxconcurrentdispatches",
      "transcript_monitor_max_concurrent_dispatches",
      "transcript-dispatch-cap",
    ],
    kind: "numeric",
    scopes: ["global", "project"],
    default: 0,
    zodSchema: z.number().int().min(0).max(64),
    docs: {
      description:
        "Cap concurrent daemon transcript dispatches (postToolUse / notification); 0 = unlimited",
      effectExplanation:
        "When the daemon detects transcript changes it fires executeDispatch without awaiting. " +
        "A positive value limits how many of those dispatches run at once for this monitor instance " +
        "(queued work starts when a slot frees). 0 preserves the previous unlimited (fire-and-forget) behavior.",
      valuePlaceholder: "0-64 (0 = unlimited)",
    },
  },
  {
    key: "updateMemoryFooter",
    aliases: [
      "update-memory-footer",
      "updatememoryfooter",
      "update_memory_footer",
      "memory-footer",
    ],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
      description: "Append memory-update guidance to stop hook footers",
      effectExplanation:
        "When enabled, stop hook block messages include a reminder to update CLAUDE.md/MEMORY.md with session learnings. This triggers the memory enforcement hook more frequently.",
      enableDescription: "Include update-memory guidance in stop hook footers",
      disableDescription: "Exclude update-memory guidance from stop hook footers",
    },
  },
  {
    key: "gitStatusGate",
    aliases: ["git-status-gate", "gitstatusgate", "git_status_gate", "git-status"],
    kind: "boolean",
    scopes: ["global"],
    default: true,
    docs: {
      description: "Block session stop when there are uncommitted changes in the git worktree",
      effectExplanation:
        "When enabled, the stop hook checks git status and blocks if modified, staged, or untracked files exist. Prevents losing work by ensuring everything is committed before ending a session.",
    },
  },
  {
    key: "nonDefaultBranchGate",
    aliases: [
      "non-default-branch-gate",
      "nondefaultbranchgate",
      "non_default_branch_gate",
      "branch-gate",
    ],
    kind: "boolean",
    scopes: ["global"],
    default: true,
    docs: {
      description: "Block session stop when on a non-default branch with unmerged work",
      effectExplanation:
        "When enabled, the stop hook checks if you're on a feature branch with unpushed or unmerged commits and blocks until the work is pushed or merged back to the default branch.",
    },
  },
  {
    key: "githubCiGate",
    aliases: ["github-ci-gate", "githubcigate", "github_ci_gate", "ci-gate"],
    kind: "boolean",
    scopes: ["global", "project"],
    default: true,
    docs: {
      description: "Block session stop when the latest GitHub Actions CI run is failing",
      effectExplanation:
        "When enabled, the stop hook checks the most recent CI run for the current commit and blocks if it has failed. Ensures you don't leave a session with broken CI.",
    },
  },
  {
    key: "ignoreCi",
    aliases: ["ignore-ci", "ignoreci", "ignore_ci", "no-ci"],
    kind: "boolean",
    scopes: ["global", "project"],
    default: false,
    docs: {
      description: "Completely suppress all GitHub Actions CI integration",
      effectExplanation:
        "When enabled, disables all CI-related behavior: no gh run polling, no CI stop hooks, no CI data in the status line, and CI evidence gates are treated as satisfied. Useful for repos without GitHub Actions.",
      enableDescription:
        "Suppress CI interactions (no CI wait/poll, CI hooks, CI status-line data, or CI evidence gates)",
      disableDescription: "Use normal GitHub Actions CI integration",
    },
  },
  {
    key: "changesRequestedGate",
    aliases: [
      "changes-requested-gate",
      "changesrequestedgate",
      "changes_requested_gate",
      "pr-review-gate",
    ],
    kind: "boolean",
    scopes: ["global"],
    default: true,
    docs: {
      description: "Block session stop when open PRs have unaddressed 'changes requested' reviews",
      effectExplanation:
        "When enabled, the stop hook scans open PRs for CHANGES_REQUESTED reviews and blocks until they are addressed. Prevents leaving a session with outstanding review feedback.",
    },
  },
  {
    key: "personalRepoIssuesGate",
    aliases: [
      "personal-repo-issues-gate",
      "personalrepoissuesgate",
      "personal_repo_issues_gate",
      "issue-gate",
    ],
    kind: "boolean",
    scopes: ["global"],
    default: true,
    docs: {
      description: "Block session stop when open GitHub issues exist in personal repositories",
      effectExplanation:
        "When enabled, the stop hook checks for open issues (personal repos) or self-authored/assigned issues (org repos) and blocks stop until they are addressed or triaged.",
    },
  },
  {
    key: "issueCloseGate",
    aliases: ["issue-close-gate", "issueclosegate", "issue_close_gate", "issue-close"],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
      description: "Require explicit confirmation before closing GitHub issues",
      effectExplanation:
        "When enabled, gh issue close and swiz issue close commands are blocked by a PreToolUse hook unless the close action is explicitly confirmed. Prevents accidental issue closure.",
      enableDescription: "Block issue close commands unless explicitly allowed",
      disableDescription: "Allow issue close commands without restriction",
    },
  },
  {
    key: "memoryUpdateReminder",
    aliases: [
      "memory-update-reminder",
      "memoryupdatereminder",
      "memory_update_reminder",
      "memory-reminder",
    ],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
      description: "Prompt to update CLAUDE.md/MEMORY.md with session learnings on stop",
      effectExplanation:
        "When enabled, the stop hook reminds you to capture session lessons in memory files before ending. Ensures important discoveries and decisions are persisted for future sessions.",
      enableDescription: "Prompt to update memory files when session stops",
      disableDescription: "Skip memory update reminder on session stop",
    },
  },
  {
    key: "qualityChecksGate",
    aliases: [
      "quality-checks-gate",
      "qualitychecksgate",
      "quality_checks_gate",
      "quality-checks",
      "quality-gate",
    ],
    kind: "boolean",
    scopes: ["global", "project"],
    default: true,
    docs: {
      description: "Run lint and typecheck before allowing session stop",
      effectExplanation:
        "When enabled, the stop hook runs the project's linter and type checker and blocks if either fails. Ensures code quality standards are met before ending a session.",
      enableDescription: "Run lint and typecheck quality checks before allowing session stop",
      disableDescription: "Skip lint and typecheck quality checks on session stop",
    },
  },
  {
    key: "strictNoDirectMain",
    aliases: [
      "strict-no-direct-main",
      "strictnodirectmain",
      "strict_no_direct_main",
      "strict-main",
      "no-direct-main",
    ],
    kind: "boolean",
    scopes: ["global", "project"],
    default: false,
    docs: {
      description:
        "Block all direct pushes to the default branch, requiring feature branches and PRs",
      effectExplanation:
        "When enabled, any git push to main/master is blocked regardless of repo type (solo or team). All changes must go through feature branches and pull requests. Conflicts with trunk-mode and solo collaboration mode.",
    },
  },
  {
    key: "trunkMode",
    aliases: ["trunk-mode", "trunkmode", "trunk_mode", "trunk"],
    kind: "boolean",
    scopes: ["project"],
    default: false,
    docs: {
      description: "Push directly to the default branch without feature branches or PRs",
      effectExplanation:
        "When enabled, all commits go directly to the default branch. Feature branches and PRs are skipped. Mutually exclusive with strict-no-direct-main.",
      enableDescription: "Enable trunk-based development (push directly to default branch, no PRs)",
      disableDescription: "Disable trunk mode (use feature branches and PRs)",
    },
  },
  {
    key: "prAgeGateMinutes",
    aliases: ["pr-age-gate", "pragegate", "pr_age_gate", "pragegateminutes", "pr-age-gate-minutes"],
    kind: "numeric",
    scopes: ["global"],
    default: 10,
    docs: {
      description: "Minimum age (minutes) a PR must reach before merge is allowed",
      effectExplanation:
        "Sets how long a PR must exist before it can be merged. Gives reviewers time to see the PR. Set to 0 to disable the age gate entirely.",
      valuePlaceholder: "minutes",
    },
  },
  {
    key: "pushCooldownMinutes",
    aliases: [
      "push-cooldown-minutes",
      "pushcooldownminutes",
      "push_cooldown_minutes",
      "push-cooldown",
    ],
    kind: "numeric",
    scopes: ["global"],
    default: 0,
    docs: {
      description: "Minimum wait time (minutes) between consecutive git pushes",
      effectExplanation:
        "Enforces a cooldown period after each push. Prevents rapid-fire pushes that can overwhelm CI. Set to 0 to disable.",
      valuePlaceholder: "minutes",
    },
  },
  {
    key: "taskDurationWarningMinutes",
    aliases: [
      "task-duration-warning-minutes",
      "taskdurationwarningminutes",
      "task_duration_warning_minutes",
      "task-duration-warning",
      "slow-task-warning-minutes",
    ],
    kind: "numeric",
    scopes: ["global", "project"],
    default: 10,
    docs: {
      description: "Warn when a task has been in_progress longer than this many minutes",
      effectExplanation:
        "Triggers a warning in the status line and stop hooks when a single task exceeds this runtime, signaling it may need to be broken down or is stuck.",
      valuePlaceholder: "minutes",
    },
  },
  {
    key: "narratorSpeed",
    aliases: ["narrator-speed", "narratorspeed", "narrator_speed", "speed"],
    kind: "numeric",
    scopes: ["global"],
    default: 0,
    zodSchema: z.number().min(0).max(600),
    docs: {
      description: "TTS narrator speech rate in words per minute (0 = system default)",
      effectExplanation:
        "Controls how fast the TTS narrator speaks. Higher values = faster speech. Set to 0 to use the system default rate. Requires speak to be enabled.",
      valuePlaceholder: "wpm",
    },
  },
  {
    key: "memoryLineThreshold",
    aliases: ["memory-line-threshold", "memorylinethreshold", "memory_line_threshold"],
    kind: "numeric",
    scopes: ["global", "project"],
    default: 1400,
    docs: {
      description: "Maximum line count for CLAUDE.md before triggering a compaction warning",
      effectExplanation:
        "When CLAUDE.md exceeds this line count, hooks warn you to run /compact-memory. Keeps memory files from growing unbounded and consuming too much context.",
      valuePlaceholder: "lines",
    },
  },
  {
    key: "memoryWordThreshold",
    aliases: ["memory-word-threshold", "memorywordthreshold", "memory_word_threshold"],
    kind: "numeric",
    scopes: ["global", "project"],
    default: 5000,
    docs: {
      description: "Maximum word count for CLAUDE.md before triggering a compaction warning",
      effectExplanation:
        "When CLAUDE.md exceeds this word count, hooks warn you to run /compact-memory. Works alongside memory-line-threshold — whichever limit is hit first triggers the warning.",
      valuePlaceholder: "words",
    },
  },
  {
    key: "dirtyWorktreeThreshold",
    aliases: [
      "dirty-worktree-threshold",
      "dirtyworktreethreshold",
      "dirty_worktree_threshold",
      "dirty-threshold",
    ],
    kind: "numeric",
    scopes: ["global", "project"],
    default: 15,
    docs: {
      description: "Maximum uncommitted files before the worktree gate blocks further edits",
      effectExplanation:
        "When the number of modified/untracked files exceeds this threshold, PreToolUse hooks block new edits until you commit or clean up. Prevents runaway uncommitted changes.",
      valuePlaceholder: "files",
    },
  },
  {
    key: "largeFileSizeKb",
    aliases: ["large-file-size-kb", "largefilesizekb", "large_file_size_kb"],
    kind: "numeric",
    scopes: ["global", "project"],
    default: 500,
    docs: {
      description: "Warn when committing files larger than this size (KB)",
      effectExplanation:
        "Files exceeding this size trigger a warning in the push-checks-gate hook. The warning is advisory — use large-file-size-block-kb for a hard block.",
      valuePlaceholder: "kb",
    },
  },
  {
    key: "largeFileSizeBlockKb",
    aliases: ["large-file-size-block-kb", "largefilesizeblockkb", "large_file_size_block_kb"],
    kind: "numeric",
    scopes: ["global"],
    default: 5120,
    docs: {
      description: "Hard-block pushes containing files larger than this size (KB)",
      effectExplanation:
        "Files exceeding this size (default 5 MB) cause the push-checks-gate hook to block the push entirely. Prevents accidentally pushing large binaries to the repo.",
      valuePlaceholder: "kb",
    },
  },
  {
    key: "defaultBranch",
    aliases: ["default-branch", "defaultbranch", "default_branch"],
    kind: "string",
    scopes: ["project"],
    docs: {
      description: "Override the auto-detected default branch name for this project",
      effectExplanation:
        "Sets the branch name used as the merge target and push protection reference. When unset, swiz auto-detects from git remote HEAD (usually 'main' or 'master').",
      valuePlaceholder: "name",
    },
    validate: (v: string): string | null => {
      if (!v.trim()) {
        return `Invalid value "${v}" for default-branch. Must be a non-empty branch name`
      }
      if (v !== v.trim()) {
        return `Invalid value "${v}" for default-branch. Do not include leading or trailing whitespace`
      }
      if (/\s/.test(v)) {
        return `Invalid value "${v}" for default-branch. Branch names cannot contain whitespace`
      }
      return null
    },
  },
  {
    key: "narratorVoice",
    aliases: ["narrator-voice", "narratorvoice", "narrator_voice", "voice"],
    kind: "string",
    scopes: ["global"],
    default: "",
    docs: {
      description: "TTS voice name for the narrator (empty = system default)",
      effectExplanation:
        "Selects which voice the TTS narrator uses. Available voices depend on your system. Leave empty to use the system default. Requires speak to be enabled.",
      valuePlaceholder: "name",
    },
  },
  {
    key: "ambitionMode",
    aliases: ["ambition-mode", "ambitionmode", "ambition_mode", "ambition"],
    kind: "string",
    scopes: ["global", "project", "session"],
    default: "standard",
    zodSchema: ambitionModeSchema,
    docs: {
      description: "Controls how aggressively the agent pursues goals and takes initiative",
      effectExplanation:
        "standard: balanced approach, follows instructions closely. aggressive: takes more initiative, tackles adjacent issues. creative: explores alternative solutions. reflective: pauses to evaluate before acting.",
      valuePlaceholder: "standard|aggressive|creative|reflective",
    },
    validate: (v) =>
      ambitionModeSchema.safeParse(v).success
        ? null
        : `Invalid value "${v}" for ambition-mode. Must be: ${ambitionModeSchema.options.join(" | ")}`,
  },
  {
    key: "collaborationMode",
    aliases: [
      "collaboration-mode",
      "collaborationmode",
      "collaboration_mode",
      "collaboration",
      "collab-mode",
      "collab",
    ],
    kind: "string",
    scopes: ["global", "project", "session"],
    default: "auto",
    zodSchema: collaborationModeSchema,
    docs: {
      description: "Controls branch and PR workflow behavior based on repo collaboration style",
      effectExplanation:
        "auto: detects from GitHub repo metadata (solo owner = direct push, org/team = PRs). solo: always push directly to main. team: always use feature branches and PRs. relaxed-collab: team workflow with relaxed gates.",
      valuePlaceholder: "auto|solo|team|relaxed-collab",
    },
    validate: (v) =>
      collaborationModeSchema.safeParse(v).success
        ? null
        : `Invalid value "${v}" for collaboration-mode. Must be: ${collaborationModeSchema.options.join(" | ")}`,
  },
  {
    key: "autoTransition",
    aliases: ["auto-transition", "autotransition", "auto_transition"],
    kind: "boolean",
    scopes: ["global"],
    default: true,
    docs: {
      description:
        "Allow multi-step task status auto-transitions (e.g. pending→in_progress→completed in one step)",
      effectExplanation:
        "When enabled, completing a pending task automatically transitions it through in_progress first. When disabled, each status transition must be explicit — a pending task must be set to in_progress before it can be completed.",
      enableDescription:
        "Enable automatic task status transitions (pending→completed skips through in_progress)",
      disableDescription: "Require explicit status transitions (pending→in_progress→completed)",
    },
  },
  {
    key: "auditStrictness",
    aliases: [
      "audit-strictness",
      "auditstrictness",
      "audit_strictness",
      "audit-mode",
      "auditmode",
      "audit_mode",
      "governance-mode",
      "governance",
    ],
    kind: "string",
    scopes: ["global", "project"],
    default: "strict",
    zodSchema: auditStrictnessSchema,
    docs: {
      description:
        "Controls how strictly task creation, evidence, and governance rules are enforced",
      effectExplanation:
        "strict: all task/evidence rules always enforced. relaxed: loosened for exploratory work (fewer task requirements). local-dev: relaxed locally but strict rules apply before push/CI.",
      valuePlaceholder: "strict|relaxed|local-dev",
      setDescription:
        "Control task/evidence governance: strict (always enforce), relaxed (relax for exploratory), local-dev (relax locally, strict for push/CI)",
    },
    validate: (v) =>
      auditStrictnessSchema.safeParse(v).success
        ? null
        : `Invalid value "${v}" for audit-strictness. Must be: ${auditStrictnessSchema.options.join(" | ")}`,
  },
  {
    key: "actionPlanMerge",
    aliases: ["action-plan-merge", "actionplanmerge", "action_plan_merge"],
    kind: "boolean",
    scopes: ["global", "project"],
    default: false,
    docs: {
      description:
        "Allow hooks to auto-create tasks from action plan steps and skill steps (opt-in)",
      effectExplanation:
        "When enabled, hooks auto-create pending tasks from action plan steps (e.g. stop-ship-checklist, task governance) and from skill steps (posttooluse-skill-steps). Disabled by default — opt in to enable automatic task creation.",
      enableDescription: "Auto-create tasks from hook action plan steps and skill steps",
      disableDescription:
        "Show action plan steps in block messages only — do not auto-create tasks",
    },
  },
  {
    key: "enforceEndOfDay",
    aliases: ["enforce-end-of-day", "enforceendofday", "enforce_end_of_day"],
    kind: "boolean",
    scopes: ["global"],
    default: true,
    docs: {
      description: "Block session stop when unpushed commits exist and /end-of-day hasn't run",
      effectExplanation:
        "When enabled, the stop hook checks for unpushed commits and blocks until /end-of-day is invoked. Ensures each session ends with a proper handoff — commits pushed, evidence posted, follow-ups filed.",
      enableDescription: "Enforce /end-of-day ceremony before stopping with outstanding work",
      disableDescription: "Allow session stop without enforcing /end-of-day ceremony",
    },
  },
  {
    key: "enforceMidSessionCheckin",
    aliases: [
      "enforce-mid-session-checkin",
      "enforcemidsessioncheckin",
      "enforce_mid_session_checkin",
    ],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
      description:
        "Suggest /mid-session-checkin when drift signals fire during long sessions (opt-in)",
      effectExplanation:
        "When enabled, a PostToolUse hook fires on Edit/Write after 3+ hours and suggests /mid-session-checkin when drift signals are detected (many uncommitted files, stale last commit, new review-requested PRs).",
      enableDescription: "Suggest /mid-session-checkin when the session drifts (experimental)",
      disableDescription: "Do not suggest /mid-session-checkin based on activity signals",
    },
  },
  {
    key: "enforceMorningStandup",
    aliases: ["enforce-morning-standup", "enforcemorningstandup", "enforce_morning_standup"],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
      description: "Suggest /morning-standup at session start once per calendar day (opt-in)",
      effectExplanation:
        "When enabled, a SessionStart hook fires once per cwd per calendar day and softly suggests /morning-standup before picking work. Uses a calendar-day sentinel so a session that restarts later in the day does not re-fire.",
      enableDescription: "Suggest /morning-standup once per day at session start",
      disableDescription: "Do not suggest /morning-standup at session start",
    },
  },
  {
    key: "enforceWeeklyRetro",
    aliases: ["enforce-weekly-retro", "enforceweeklyretro", "enforce_weekly_retro"],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
      description: "Suggest /weekly-retro on the first session of each ISO week (opt-in)",
      effectExplanation:
        "When enabled, a SessionStart hook fires on the first session of each ISO week (provided the last 7 days have ≥3 merged PRs) and softly suggests /weekly-retro. Uses an ISO-week sentinel to fire at most once per week.",
      enableDescription: "Suggest /weekly-retro once per ISO week at session start",
      disableDescription: "Do not suggest /weekly-retro at session start",
    },
  },
]

/**
 * Derive a defaults object from the registry. Keys with `default` defined
 * are included; keys without (e.g. project-only strings like defaultBranch)
 * are omitted. Consumers add non-registry fields (sessions, statusLineSegments)
 * separately.
 */
export function deriveDefaultsFromRegistry(): Record<string, boolean | number | string> {
  const defaults: Record<string, boolean | number | string> = {}
  for (const def of SETTINGS_REGISTRY) {
    if (def.default !== undefined) {
      defaults[def.key] = def.default
    }
  }
  return defaults
}

/**
 * Derive the Zod schema shape for global settings from the registry.
 * Each registry entry with a `default` produces a schema field with `.catch(default)`.
 * Entries with `zodSchema` use that schema; otherwise derived from `kind`.
 * Non-registry fields (statusLineSegments, sessions, disabledHooks) must be added by the caller.
 */
export function deriveSchemaShape(): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const def of SETTINGS_REGISTRY) {
    if (def.default === undefined) continue
    if (def.zodSchema) {
      shape[def.key] = def.zodSchema.catch(def.default)
    } else if (def.kind === "boolean") {
      shape[def.key] = z.boolean().catch(def.default as boolean)
    } else if (def.kind === "numeric") {
      shape[def.key] = z
        .number()
        .int()
        .min(def.default === 0 ? 0 : 1)
        .catch(def.default as number)
    } else {
      shape[def.key] = z
        .string()
        .max(200)
        .catch(def.default as string)
    }
  }
  return shape
}

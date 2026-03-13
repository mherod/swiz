import type { SettingDef } from "./types"
import { ambitionModeSchema, collaborationModeSchema } from "./types"

export const SETTINGS_REGISTRY: SettingDef[] = [
  {
    key: "autoContinue",
    aliases: ["auto-continue", "autocontinue", "auto_continue"],
    kind: "boolean",
    scopes: ["global", "session"],
    docs: {
      enableDescription: "Enable stop auto-continue behavior",
      disableDescription: "Disable stop auto-continue behavior",
    },
  },
  {
    key: "prMergeMode",
    aliases: ["pr-merge-mode", "prmergemode", "pr_merge_mode", "pr-merge", "prmerge"],
    kind: "boolean",
    scopes: ["global", "session"],
    docs: {
      enableDescription: "Enable merge-oriented PR hooks",
      disableDescription: "Disable merge-oriented PR hooks; keep creation-oriented guidance only",
    },
  },
  {
    key: "critiquesEnabled",
    aliases: ["critiques-enabled", "critiquesenabled", "critiques_enabled", "critiques"],
    kind: "boolean",
    scopes: ["global"],
    docs: {
      enableDescription: "Show Process/Product critique lines in auto-continue output",
      disableDescription: "Suppress critique lines and emit only next-step directive",
    },
  },
  {
    key: "pushGate",
    aliases: ["push-gate", "pushgate", "push_gate"],
    kind: "boolean",
    scopes: ["global"],
  },
  {
    key: "sandboxedEdits",
    aliases: ["sandboxed-edits", "sandboxededits", "sandboxed_edits"],
    kind: "boolean",
    scopes: ["global"],
    docs: {
      enableDescription: "Block file edits outside cwd and /tmp",
      disableDescription: "Allow file edits anywhere on the filesystem",
    },
  },
  {
    key: "speak",
    aliases: ["speak", "tts"],
    kind: "boolean",
    scopes: ["global"],
    docs: {
      enableDescription: "Enable TTS narrator",
      disableDescription: "Disable TTS narrator",
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
    docs: {
      enableDescription: "Include update-memory guidance in ACTION REQUIRED footers",
      disableDescription: "Exclude update-memory guidance from ACTION REQUIRED footers",
    },
  },
  {
    key: "gitStatusGate",
    aliases: ["git-status-gate", "gitstatusgate", "git_status_gate", "git-status"],
    kind: "boolean",
    scopes: ["global"],
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
  },
  {
    key: "githubCiGate",
    aliases: ["github-ci-gate", "githubcigate", "github_ci_gate", "ci-gate"],
    kind: "boolean",
    scopes: ["global"],
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
  },
  {
    key: "prAgeGateMinutes",
    aliases: ["pr-age-gate", "pragegate", "pr_age_gate", "pragegateminutes", "pr-age-gate-minutes"],
    kind: "numeric",
    scopes: ["global"],
    docs: { valuePlaceholder: "minutes" },
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
    docs: { valuePlaceholder: "minutes" },
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
    docs: { valuePlaceholder: "minutes" },
  },
  {
    key: "narratorSpeed",
    aliases: ["narrator-speed", "narratorspeed", "narrator_speed", "speed"],
    kind: "numeric",
    scopes: ["global"],
    docs: { valuePlaceholder: "wpm" },
  },
  {
    key: "memoryLineThreshold",
    aliases: ["memory-line-threshold", "memorylinethreshold", "memory_line_threshold"],
    kind: "numeric",
    scopes: ["global", "project"],
    docs: { valuePlaceholder: "lines" },
  },
  {
    key: "memoryWordThreshold",
    aliases: ["memory-word-threshold", "memorywordthreshold", "memory_word_threshold"],
    kind: "numeric",
    scopes: ["global", "project"],
    docs: { valuePlaceholder: "words" },
  },
  {
    key: "largeFileSizeKb",
    aliases: ["large-file-size-kb", "largefilesizekb", "large_file_size_kb"],
    kind: "numeric",
    scopes: ["global", "project"],
    docs: { valuePlaceholder: "kb" },
  },
  {
    key: "defaultBranch",
    aliases: ["default-branch", "defaultbranch", "default_branch"],
    kind: "string",
    scopes: ["project"],
    docs: { valuePlaceholder: "name" },
    validate: (v) => {
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
    docs: { valuePlaceholder: "name" },
  },
  {
    key: "ambitionMode",
    aliases: ["ambition-mode", "ambitionmode", "ambition_mode", "ambition"],
    kind: "string",
    scopes: ["global", "project", "session"],
    docs: { valuePlaceholder: "standard|aggressive|creative|reflective" },
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
    docs: { valuePlaceholder: "auto|solo|team|relaxed-collab" },
    validate: (v) =>
      collaborationModeSchema.safeParse(v).success
        ? null
        : `Invalid value "${v}" for collaboration-mode. Must be: ${collaborationModeSchema.options.join(" | ")}`,
  },
]

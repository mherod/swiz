import { z } from "zod"
import type { SettingDef } from "./types"
import { ambitionModeSchema, collaborationModeSchema } from "./types"

export const SETTINGS_REGISTRY: SettingDef[] = [
  {
    key: "autoContinue",
    aliases: ["auto-continue", "autocontinue", "auto_continue"],
    kind: "boolean",
    scopes: ["global", "project", "session"],
    default: true,
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
    default: true,
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
    default: true,
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
    default: false,
  },
  {
    key: "sandboxedEdits",
    aliases: ["sandboxed-edits", "sandboxededits", "sandboxed_edits"],
    kind: "boolean",
    scopes: ["global"],
    default: true,
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
    default: false,
    docs: {
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
      enableDescription: "Type 'Continue' into the terminal after every tool call via AppleScript",
      disableDescription: "Disable auto-steer terminal input",
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
      enableDescription: "Include update-memory guidance in ACTION REQUIRED footers",
      disableDescription: "Exclude update-memory guidance from ACTION REQUIRED footers",
    },
  },
  {
    key: "gitStatusGate",
    aliases: ["git-status-gate", "gitstatusgate", "git_status_gate", "git-status"],
    kind: "boolean",
    scopes: ["global"],
    default: true,
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
  },
  {
    key: "githubCiGate",
    aliases: ["github-ci-gate", "githubcigate", "github_ci_gate", "ci-gate"],
    kind: "boolean",
    scopes: ["global"],
    default: true,
  },
  {
    key: "ignoreCi",
    aliases: ["ignore-ci", "ignoreci", "ignore_ci", "no-ci"],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
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
  },
  {
    key: "issueCloseGate",
    aliases: ["issue-close-gate", "issueclosegate", "issue_close_gate", "issue-close"],
    kind: "boolean",
    scopes: ["global"],
    default: false,
    docs: {
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
  },
  {
    key: "trunkMode",
    aliases: ["trunk-mode", "trunkmode", "trunk_mode", "trunk"],
    kind: "boolean",
    scopes: ["project"],
    default: false,
    docs: {
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
    default: 0,
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
    default: 10,
    docs: { valuePlaceholder: "minutes" },
  },
  {
    key: "narratorSpeed",
    aliases: ["narrator-speed", "narratorspeed", "narrator_speed", "speed"],
    kind: "numeric",
    scopes: ["global"],
    default: 0,
    zodSchema: z.number().min(0).max(600),
    docs: { valuePlaceholder: "wpm" },
  },
  {
    key: "memoryLineThreshold",
    aliases: ["memory-line-threshold", "memorylinethreshold", "memory_line_threshold"],
    kind: "numeric",
    scopes: ["global", "project"],
    default: 1400,
    docs: { valuePlaceholder: "lines" },
  },
  {
    key: "memoryWordThreshold",
    aliases: ["memory-word-threshold", "memorywordthreshold", "memory_word_threshold"],
    kind: "numeric",
    scopes: ["global", "project"],
    default: 5000,
    docs: { valuePlaceholder: "words" },
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
    docs: { valuePlaceholder: "files" },
  },
  {
    key: "largeFileSizeKb",
    aliases: ["large-file-size-kb", "largefilesizekb", "large_file_size_kb"],
    kind: "numeric",
    scopes: ["global", "project"],
    default: 500,
    docs: { valuePlaceholder: "kb" },
  },
  {
    key: "defaultBranch",
    aliases: ["default-branch", "defaultbranch", "default_branch"],
    kind: "string",
    scopes: ["project"],
    docs: { valuePlaceholder: "name" },
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
    docs: { valuePlaceholder: "name" },
  },
  {
    key: "ambitionMode",
    aliases: ["ambition-mode", "ambitionmode", "ambition_mode", "ambition"],
    kind: "string",
    scopes: ["global", "project", "session"],
    default: "standard",
    zodSchema: ambitionModeSchema,
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
    default: "auto",
    zodSchema: collaborationModeSchema,
    docs: { valuePlaceholder: "auto|solo|team|relaxed-collab" },
    validate: (v) =>
      collaborationModeSchema.safeParse(v).success
        ? null
        : `Invalid value "${v}" for collaboration-mode. Must be: ${collaborationModeSchema.options.join(" | ")}`,
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

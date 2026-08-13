import { resolve } from "node:path"
import { z } from "zod"

const eslintMessageSchema = z.looseObject({
  severity: z.number(),
  ruleId: z.string().nullable(),
  line: z.number().optional(),
  column: z.number().optional(),
  message: z.string(),
})

const eslintResultSchema = z.array(
  z.looseObject({
    filePath: z.string(),
    messages: z.array(eslintMessageSchema),
  })
)

type EslintResults = z.infer<typeof eslintResultSchema>

interface OwnerSlice {
  issue: number
  name: string
  matches: (path: string) => boolean
}

const HOOK_REPOSITORY_RE =
  /(branch-intent|git-index-lock|issue-workflow|main-branch|pr-|workflow-permissions|concurrent-session|push-autosteer)/
const HOOK_LIFECYCLE_RE = /(measure-|sessionstart-|stop-)/
const OPERATOR_COMMAND_RE = /\/(manage|mcp|settings|skill|status-line|status)\.ts$/
const TYPED_SCHEMA_PATHS = new Set([
  "src/active-skills-context.ts",
  "src/repository-capability.ts",
  "src/schemas.ts",
])
const CORE_STATE_PATHS = new Set([
  "src/auto-steer-store.ts",
  "src/auto-steer/pr-review-tracker.ts",
  "src/collaboration-policy.ts",
  "src/hook-log.ts",
  "src/issue-store-rest-fallback.ts",
  "src/issue-store-sync.ts",
  "src/issue-store.ts",
  "src/settings/persistence.ts",
])
const CORE_UTILITY_PATHS = new Set([
  "index.ts",
  "src/action-plan.ts",
  "src/agent-paths.ts",
  "src/detect-frameworks.ts",
  "src/speech.ts",
  "src/tools.ts",
  "src/utils/auto-steer-helpers.ts",
  "src/utils/daemon-git-state.ts",
  "src/utils/hook-output-agent-compat.ts",
  "src/utils/humanise.ts",
  "src/utils/inline-hook-helpers.ts",
  "src/utils/jsonl.ts",
  "src/utils/test-utils.ts",
])

export const OWNER_SLICES: readonly OwnerSlice[] = [
  {
    issue: 780,
    name: "hook-task",
    matches: (path) => path.startsWith("hooks/") && /task/i.test(path),
  },
  {
    issue: 781,
    name: "hook-repository",
    matches: (path) => path.startsWith("hooks/") && HOOK_REPOSITORY_RE.test(path),
  },
  {
    issue: 782,
    name: "hook-lifecycle",
    matches: (path) => path.startsWith("hooks/") && HOOK_LIFECYCLE_RE.test(path),
  },
  { issue: 783, name: "hook-safety", matches: (path) => path.startsWith("hooks/") },
  {
    issue: 784,
    name: "command-runtime",
    matches: (path) =>
      path.startsWith("src/commands/daemon") || path.startsWith("src/commands/doctor"),
  },
  {
    issue: 785,
    name: "command-operator",
    matches: (path) => path.startsWith("src/commands/") && OPERATOR_COMMAND_RE.test(path),
  },
  { issue: 786, name: "command-other", matches: (path) => path.startsWith("src/commands/") },
  { issue: 787, name: "dispatch", matches: (path) => path.startsWith("src/dispatch/") },
  { issue: 788, name: "tasks", matches: (path) => path.startsWith("src/tasks/") },
  {
    issue: 789,
    name: "transcript-parsers",
    matches: (path) => /^src\/transcript-analysis-parse-part[12]\.ts$/.test(path),
  },
  { issue: 790, name: "transcript-runtime", matches: (path) => path.startsWith("src/transcript") },
  { issue: 791, name: "typed-schemas", matches: (path) => TYPED_SCHEMA_PATHS.has(path) },
  { issue: 792, name: "infractions", matches: (path) => path === "src/infractions.ts" },
  { issue: 793, name: "skill-utils", matches: (path) => path === "src/skill-utils.ts" },
  { issue: 794, name: "core-state", matches: (path) => CORE_STATE_PATHS.has(path) },
  { issue: 795, name: "core-utilities", matches: (path) => CORE_UTILITY_PATHS.has(path) },
]

export function ownerForPath(path: string): Pick<OwnerSlice, "issue" | "name"> {
  const owner = OWNER_SLICES.find((slice) => slice.matches(path))
  if (!owner) throw new Error(`No warning owner for ${path}`)
  return { issue: owner.issue, name: owner.name }
}

interface WarningDetail {
  ruleId: string
  line: number
  column: number
  message: string
}

interface FileInventory {
  path: string
  warningCount: number
  warnings: WarningDetail[]
}

interface OwnerInventory {
  issue: number
  name: string
  warningCount: number
  files: FileInventory[]
}

export interface WarningInventory {
  schemaVersion: 1
  umbrellaIssue: 778
  originalWarningCount: 258
  warningCount: number
  rules: Array<{ ruleId: string; warningCount: number }>
  owners: OwnerInventory[]
}

function relativePath(filePath: string, root: string): string {
  const prefix = `${root}/`
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath
}

function sortWarnings(warnings: WarningDetail[]): WarningDetail[] {
  return warnings.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId) ||
      left.message.localeCompare(right.message)
  )
}

export function buildWarningInventory(results: EslintResults, root: string): WarningInventory {
  const ruleCounts = new Map<string, number>()
  const filesByOwner = new Map<number, FileInventory[]>()

  for (const result of results) {
    const warnings = result.messages
      .filter((message) => message.severity === 1)
      .map((message) => ({
        ruleId: message.ruleId ?? "unclassified",
        line: message.line ?? 0,
        column: message.column ?? 0,
        message: message.message,
      }))
    if (warnings.length === 0) continue

    const path = relativePath(result.filePath, root)
    const owner = ownerForPath(path)
    for (const warning of warnings) {
      ruleCounts.set(warning.ruleId, (ruleCounts.get(warning.ruleId) ?? 0) + 1)
    }
    const files = filesByOwner.get(owner.issue) ?? []
    files.push({ path, warningCount: warnings.length, warnings: sortWarnings(warnings) })
    filesByOwner.set(owner.issue, files)
  }

  const owners = OWNER_SLICES.map(({ issue, name }) => {
    const files = (filesByOwner.get(issue) ?? []).sort((left, right) =>
      left.path.localeCompare(right.path)
    )
    return {
      issue,
      name,
      warningCount: files.reduce((total, file) => total + file.warningCount, 0),
      files,
    }
  })
  const rules = [...ruleCounts.entries()]
    .map(([ruleId, warningCount]) => ({ ruleId, warningCount }))
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId))

  return {
    schemaVersion: 1,
    umbrellaIssue: 778,
    originalWarningCount: 258,
    warningCount: rules.reduce((total, rule) => total + rule.warningCount, 0),
    rules,
    owners,
  }
}

export function stringifyWarningInventory(inventory: WarningInventory): string {
  return `${JSON.stringify(inventory, null, 2)}\n`
}

async function runEslint(root: string): Promise<EslintResults> {
  const proc = Bun.spawn(["bun", "x", "eslint", ".", "--format", "json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (!stdout.trim()) throw new Error(stderr.trim() || `ESLint exited ${proc.exitCode}`)
  return eslintResultSchema.parse(JSON.parse(stdout))
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..")
  const inventory = buildWarningInventory(await runEslint(root), root)
  const output = stringifyWarningInventory(inventory)
  if (process.argv.includes("--write")) {
    await Bun.write(resolve(root, "docs", "lint-warning-inventory.json"), output)
    return
  }
  process.stdout.write(output)
}

if (import.meta.main) {
  await main()
}

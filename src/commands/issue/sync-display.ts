import { getRepoSlug } from "../../git-helpers.ts"
import { getIssueStore } from "../../issue-store.ts"
import { syncUpstreamState, type UpstreamSyncResult } from "../../issue-store-sync.ts"
import { ensureFreshData } from "./operations.ts"

type Row = [string, string]
type ChangeList = { changes: { kind: string; key: string; reason: string }[] }

function fmtEntity(
  rows: Row[],
  name: string,
  b: { upserted: number; removed: number; skipped: number } & ChangeList
): void {
  if (b.upserted === 0 && b.removed === 0 && b.skipped === 0) return
  const parts: string[] = []
  if (b.upserted > 0) parts.push(`\x1b[32m+${b.upserted}\x1b[0m`)
  if (b.removed > 0) parts.push(`\x1b[31m-${b.removed}\x1b[0m`)
  if (b.skipped > 0) parts.push(`\x1b[2m${b.skipped} unchanged\x1b[0m`)
  rows.push([name, parts.join("  ")])
  for (const c of b.changes) {
    const icon =
      c.kind === "new"
        ? "\x1b[32m+\x1b[0m"
        : c.kind === "removed"
          ? "\x1b[31m-\x1b[0m"
          : "\x1b[33m~\x1b[0m"
    rows.push(["", `  ${icon} ${c.key} \x1b[2m${c.reason}\x1b[0m`])
  }
}

function fmtTracked(rows: Row[], name: string, b: { upserted: number } & ChangeList): void {
  if (b.upserted === 0) return
  rows.push([name, `\x1b[32m+${b.upserted}\x1b[0m`])
  for (const c of b.changes) {
    const icon = c.kind === "new" ? "\x1b[32m+\x1b[0m" : "\x1b[33m~\x1b[0m"
    rows.push(["", `  ${icon} ${c.key} \x1b[2m${c.reason}\x1b[0m`])
  }
}

function printSyncSummary(result: UpstreamSyncResult): void {
  const r = result
  const rows: Row[] = []
  fmtEntity(rows, "Issues", r.issues)
  fmtEntity(rows, "PRs", r.pullRequests)
  fmtTracked(rows, "CI statuses", r.ciStatuses)
  if (r.comments.upserted > 0) rows.push(["Comments", `\x1b[32m+${r.comments.upserted}\x1b[0m`])
  fmtEntity(rows, "Labels", r.labels)
  fmtEntity(rows, "Milestones", r.milestones)
  fmtTracked(rows, "Branch CI", r.branchCi)
  fmtTracked(rows, "PR detail", r.prBranchDetail)
  fmtTracked(rows, "Protection", r.branchProtection)

  if (rows.length > 0) {
    const maxLabel = Math.max(...rows.map(([l]) => l.length))
    for (const [label, value] of rows) {
      console.log(`  ${label.padEnd(maxLabel)}  ${value}`)
    }
  }
}

interface StoredItem {
  number: number
  title: string
  state?: string
  assignees?: Array<{ login: string }>
}

export function printOpenItems(repo: string, assigneeFilter?: string): void {
  const store = getIssueStore()
  const issues = store.listIssues<StoredItem>(repo, Number.MAX_SAFE_INTEGER)
  const prs = store.listPullRequests<StoredItem>(repo, Number.MAX_SAFE_INTEGER)

  let openIssues = issues.filter((i) => i.state?.toLowerCase() === "open")
  let openPrs = prs.filter((pr) => pr.state?.toLowerCase() === "open")

  if (assigneeFilter) {
    const login = assigneeFilter.toLowerCase()
    openIssues = openIssues.filter((i) => i.assignees?.some((a) => a.login.toLowerCase() === login))
    openPrs = openPrs.filter((pr) => pr.assignees?.some((a) => a.login.toLowerCase() === login))
  }

  if (openIssues.length > 0) {
    console.log(`\nOpen Issues (${openIssues.length}):`)
    for (const issue of openIssues) {
      console.log(`  #${issue.number} ${issue.title}`)
    }
  }
  if (openPrs.length > 0) {
    console.log(`\nOpen Pull Requests (${openPrs.length}):`)
    for (const pr of openPrs) {
      console.log(`  #${pr.number} ${pr.title}`)
    }
  }
}

export async function handleSync(args: string[]): Promise<void> {
  const cwd = process.cwd()
  let repo: string | null = args[1] ?? null
  if (!repo) {
    repo = await getRepoSlug(cwd)
  }
  if (!repo) {
    throw new Error(
      `Repo required. Usage: swiz issue sync [<repo>]\nOr run this in a git repo with an origin.`
    )
  }

  let syncAge = ""
  try {
    const { getIssueStoreDbPath } = await import("../../issue-store.ts")
    const dbPath = getIssueStoreDbPath()
    const s = await Bun.file(dbPath).stat()
    const ageMs = Date.now() - s.mtimeMs
    if (ageMs < 60_000) syncAge = ` (last synced <1m ago)`
    else if (ageMs < 3_600_000) syncAge = ` (last synced ${Math.floor(ageMs / 60_000)}m ago)`
    else if (ageMs < 86_400_000) syncAge = ` (last synced ${Math.floor(ageMs / 3_600_000)}h ago)`
    else syncAge = ` (last synced ${Math.floor(ageMs / 86_400_000)}d ago)`
  } catch {
    syncAge = " (first sync)"
  }
  console.log(`🔄 Syncing upstream state for ${repo}${syncAge}...`)
  const result = await syncUpstreamState(repo, cwd)

  const allChanges = [
    ...result.issues.changes,
    ...result.pullRequests.changes,
    ...result.ciStatuses.changes,
    ...result.labels.changes,
    ...result.milestones.changes,
    ...result.branchCi.changes,
    ...result.prBranchDetail.changes,
    ...result.branchProtection.changes,
  ]
  const totalUnchanged =
    result.issues.skipped +
    result.pullRequests.skipped +
    result.labels.skipped +
    result.milestones.skipped

  if (allChanges.length === 0 && totalUnchanged > 0) {
    const parts: string[] = []
    if (result.issues.skipped > 0)
      parts.push(`${result.issues.skipped} issue${result.issues.skipped === 1 ? "" : "s"}`)
    if (result.pullRequests.skipped > 0)
      parts.push(`${result.pullRequests.skipped} PR${result.pullRequests.skipped === 1 ? "" : "s"}`)
    if (result.labels.skipped > 0)
      parts.push(`${result.labels.skipped} label${result.labels.skipped === 1 ? "" : "s"}`)
    if (result.milestones.skipped > 0)
      parts.push(
        `${result.milestones.skipped} milestone${result.milestones.skipped === 1 ? "" : "s"}`
      )
    const breakdown = parts.length > 0 ? parts.join(", ") : `${totalUnchanged} entities`
    console.log(`✅ Already up to date (${breakdown} unchanged)`)
  } else {
    console.log("✅ Sync complete:\n")
    printSyncSummary(result)
  }

  printOpenItems(repo)
}

async function resolveCurrentUser(): Promise<string> {
  const proc = Bun.spawn(["gh", "api", "user", "-q", ".login"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const login = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  if (proc.exitCode !== 0 || !login) {
    throw new Error("Failed to resolve current GitHub user via `gh api user`")
  }
  return login
}

export async function handleList(args: string[]): Promise<void> {
  const cwd = process.cwd()
  const mine = args.includes("--mine")
  const positionals = args.filter((a) => !a.startsWith("--"))
  let repo: string | null = positionals[1] ?? null
  if (!repo) {
    repo = await getRepoSlug(cwd)
  }
  if (!repo) {
    throw new Error(
      `Repo required. Usage: swiz issue list [<repo>] [--mine]\nOr run this in a git repo with an origin.`
    )
  }

  await ensureFreshData(repo, cwd)

  const assigneeFilter = mine ? await resolveCurrentUser() : undefined
  const label = mine ? `Issues assigned to ${assigneeFilter}` : `Open Issues for ${repo}`
  console.log(`\n${label}:`)
  printOpenItems(repo, assigneeFilter)
}

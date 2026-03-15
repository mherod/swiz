import type { CSSProperties } from "react"
import { useEffect, useState } from "react"
import { postJson } from "../lib/http.ts"

interface ProjectIssueLabel {
  name: string
  color: string | null
}

interface ProjectIssueActor {
  login: string
}

interface ProjectIssue {
  number: number
  title: string
  updatedAt: string | null
  state: string | null
  author: ProjectIssueActor | null
  assignees: ProjectIssueActor[]
  labels: ProjectIssueLabel[]
}

interface ProjectIssuesResponse {
  repo: string | null
  issues: ProjectIssue[]
}

function formatIssueCount(count: number): string {
  return `${count} open issue${count === 1 ? "" : "s"}`
}

function formatIssueUpdatedAt(updatedAt: string | null): string {
  if (!updatedAt) return "Updated recently"
  const value = new Date(updatedAt)
  if (Number.isNaN(value.getTime())) return "Updated recently"
  return value.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function splitRepo(repo: string | null): { owner: string; name: string } | null {
  if (!repo) return null
  const [owner, name] = repo.split("/")
  if (!owner || !name) return { owner: repo, name: repo }
  return { owner, name }
}

function repoMonogram(repo: string | null): string {
  const parts = splitRepo(repo)
  if (!parts) return "SW"
  return `${parts.owner[0] ?? ""}${parts.name[0] ?? ""}`.toUpperCase()
}

function emptyStateContent(
  cwd: string | null,
  repo: string | null
): { title: string; body: string } {
  if (!cwd) {
    return {
      title: "No project selected",
      body: "Pick a project in the left rail to inspect its cached GitHub issues.",
    }
  }
  if (!repo) {
    return {
      title: "No GitHub remote",
      body: "This project is not linked to GitHub, so there is no issue cache to show here.",
    }
  }
  return {
    title: "Cache is clear",
    body: "No open issues are currently cached for this repository. If that looks wrong, the daemon likely has not refreshed GitHub yet.",
  }
}

function labelStyle(color: string | null): CSSProperties | undefined {
  if (!color) return undefined
  return {
    borderColor: `#${color}66`,
    background: `#${color}1f`,
    color: `#${color}`,
  }
}

export function ProjectIssuesPanel({ cwd }: { cwd: string | null }) {
  const [repo, setRepo] = useState<string | null>(null)
  const [issues, setIssues] = useState<ProjectIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!cwd) {
      setRepo(null)
      setIssues([])
      setLoading(false)
      setError("")
      return
    }

    let disposed = false
    setRepo(null)
    setIssues([])
    setError("")

    const loadIssues = async (isInitialLoad: boolean) => {
      if (isInitialLoad) setLoading(true)
      try {
        const result = await postJson<ProjectIssuesResponse>("/projects/issues", { cwd, limit: 10 })
        if (disposed) return
        setRepo(result.repo)
        setIssues(result.issues ?? [])
        setError("")
      } catch (loadError) {
        if (disposed) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
        setRepo(null)
        setIssues([])
      } finally {
        if (!disposed) setLoading(false)
      }
    }

    void loadIssues(true)
    const intervalId = window.setInterval(() => void loadIssues(false), 5000)
    return () => {
      disposed = true
      window.clearInterval(intervalId)
    }
  }, [cwd])

  const repoParts = splitRepo(repo)
  const emptyState = emptyStateContent(cwd, repo)

  return (
    <section className="card project-issues-card" aria-labelledby="project-issues-title">
      <div className="project-issues-hero">
        <div>
          <p className="project-issues-kicker">GitHub cache</p>
          <div className="project-issues-title-row">
            <h2 id="project-issues-title" className="section-title">
              Issues
            </h2>
            <span className="project-issues-count-pill">
              {loading ? "Loading" : formatIssueCount(issues.length)}
            </span>
          </div>
          <p className="project-issues-summary">
            {repo
              ? `Cached open issues for ${repo}.`
              : "Repository issue state for the selected project."}
          </p>
        </div>
        <div className="project-issues-controls">
          {repoParts ? (
            <div className="project-issues-repo-badge">
              <span className="project-issues-repo-monogram">{repoMonogram(repo)}</span>
              <div>
                <div className="project-issues-repo-owner">{repoParts.owner}</div>
                <div className="project-issues-repo-name">{repoParts.name}</div>
              </div>
            </div>
          ) : null}
          {repo ? (
            <a
              className="project-issues-repo-link"
              href={`https://github.com/${repo}/issues`}
              target="_blank"
              rel="noreferrer"
            >
              View all
            </a>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="project-issues-error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="project-issues-empty-shell project-issues-empty-shell-loading">
          <div className="project-issues-empty-mark">...</div>
          <div>
            <p className="project-issues-empty-title">Refreshing cache</p>
            <p className="project-issues-empty-body">
              Loading open issues for the selected project.
            </p>
          </div>
        </div>
      ) : null}

      {!loading && !error && issues.length === 0 ? (
        <div className="project-issues-empty-shell">
          <div className="project-issues-empty-mark">{repo ? "0" : "?"}</div>
          <div>
            <p className="project-issues-empty-title">{emptyState.title}</p>
            <p className="project-issues-empty-body">{emptyState.body}</p>
          </div>
        </div>
      ) : null}

      {!loading && issues.length > 0 ? (
        <ul className="project-issues-list">
          {issues.map((issue) => (
            <li key={issue.number} className="project-issues-item">
              <a
                className="project-issues-link"
                href={repo ? `https://github.com/${repo}/issues/${issue.number}` : undefined}
                target="_blank"
                rel="noreferrer"
              >
                <div className="project-issues-row">
                  <span className="project-issues-number">#{issue.number}</span>
                  <span className="project-issues-title">{issue.title}</span>
                  <span className="project-issues-state">{issue.state ?? "OPEN"}</span>
                </div>
                <div className="project-issues-meta">
                  <span>{formatIssueUpdatedAt(issue.updatedAt)}</span>
                  {issue.author?.login ? <span>{issue.author.login}</span> : null}
                  {issue.assignees.length > 0 ? (
                    <span>
                      Assigned: {issue.assignees.map((assignee) => assignee.login).join(", ")}
                    </span>
                  ) : null}
                </div>
                {issue.labels.length > 0 ? (
                  <div className="project-issues-labels">
                    {issue.labels.slice(0, 4).map((label) => (
                      <span
                        key={label.name}
                        className="project-issues-label"
                        style={labelStyle(label.color)}
                      >
                        {label.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

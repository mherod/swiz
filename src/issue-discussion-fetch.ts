import { z } from "zod"
import type { GitHubCommentRecord, IssueStore } from "./issue-store.ts"
import { fetchViaRest } from "./issue-store-rest-fallback.ts"

const commentSchema = z.looseObject({
  id: z.number(),
  body: z.string().optional(),
  user: z.object({ login: z.string() }).optional(),
  author: z.object({ login: z.string() }).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

function parseComments(data: string): GitHubCommentRecord[] | null {
  try {
    const parsed = z.array(commentSchema).safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function normalizeComment(comment: GitHubCommentRecord): GitHubCommentRecord {
  return {
    ...comment,
    author: comment.author ?? comment.user,
    createdAt: comment.createdAt ?? comment.created_at,
    updatedAt: comment.updatedAt ?? comment.updated_at,
  }
}

interface DiscussionOptions {
  cwd: string
  issueNumber: number
  repo: string
  store: IssueStore
  signal?: AbortSignal
}

async function fetchPage(options: DiscussionOptions, page: number) {
  const { cwd, issueNumber, repo, store, signal } = options
  const endpoint = `repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`
  const cached = store.getHttpCache(repo, endpoint)
  const response = await fetchViaRest(endpoint, cwd, cached?.etag, signal)
  if (!response) return null
  if (response.status === 304) return parseComments(cached?.data ?? "")
  if (response.status !== 200) return null
  const batch = parseComments(response.body)
  if (batch && response.headers.etag) {
    store.setHttpCache(repo, endpoint, response.headers.etag, response.body)
  }
  return batch
}

/** Revalidate every page; a failed or cancelled page never yields a partial discussion. */
export async function fetchIssueDiscussion(
  options: DiscussionOptions
): Promise<GitHubCommentRecord[] | null> {
  const { signal } = options
  const comments: GitHubCommentRecord[] = []
  for (let page = 1; ; page++) {
    if (signal?.aborted) return null
    const batch = await fetchPage(options, page)
    if (!batch || signal?.aborted) return null
    comments.push(...batch.map(normalizeComment))
    if (batch.length < 100) return comments
  }
}

import type { GitClient, GitCommandResult, GitRunOptions } from "./client.ts"

export interface GitMockCall {
  args: string[]
  options: GitRunOptions
}

export type GitMockHandler = (
  args: string[],
  options: GitRunOptions
) => string | Partial<GitCommandResult> | null | undefined

function normalizeMockResult(result: string | Partial<GitCommandResult> | null | undefined) {
  if (typeof result === "string") return { stdout: result, stderr: "", exitCode: 0 }
  return {
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? "",
    exitCode: result?.exitCode ?? 0,
  }
}

export class MockGitClient implements GitClient {
  readonly calls: GitMockCall[] = []

  constructor(private readonly handler: GitMockHandler = () => ({ exitCode: 1 })) {}

  async run(args: string[], options: GitRunOptions = {}): Promise<GitCommandResult> {
    return this.runSync(args, options)
  }

  runSync(args: string[], options: GitRunOptions = {}): GitCommandResult {
    this.calls.push({ args, options })
    return normalizeMockResult(this.handler(args, options))
  }
}

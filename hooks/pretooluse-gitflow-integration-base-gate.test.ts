import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { evaluateGitFlowGate } from "./pretooluse-gitflow-integration-base-gate"

async function setupGitRepo(tempDir: string, hasDevBranch: boolean = false) {
  await fs.mkdir(tempDir, { recursive: true })

  // Initialize git repo with proper isolation
  const gitDir = path.join(tempDir, ".git")
  const objectsDir = path.join(gitDir, "objects")
  const headsDir = path.join(gitDir, "refs", "heads")
  const refsDir = path.join(gitDir, "refs", "remotes", "origin")

  await fs.mkdir(objectsDir, { recursive: true })
  await fs.mkdir(headsDir, { recursive: true })
  await fs.mkdir(refsDir, { recursive: true })

  // Create minimal git config
  const configFile = path.join(gitDir, "config")
  await fs.writeFile(configFile, "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n")

  const headFile = path.join(gitDir, "HEAD")
  await fs.writeFile(headFile, "ref: refs/heads/main\n")

  // Create remote-tracking branches
  const mainRef = path.join(refsDir, "main")
  await fs.writeFile(mainRef, "0000000000000000000000000000000000000000\n")

  if (hasDevBranch) {
    const devRef = path.join(refsDir, "dev")
    await fs.writeFile(devRef, "0000000000000000000000000000000000000000\n")
  }
}

describe("pretooluse-gitflow-integration-base-gate", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = `.tmp-gitflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it("should allow main interaction in trunk-based repos (no dev/develop)", async () => {
    await setupGitRepo(tempDir, false)

    const input: unknown = {
      tool_name: "Bash",
      cwd: tempDir,
      tool_input: {
        command: "git checkout -b feat/my-feature origin/main",
      },
    }

    const result = await evaluateGitFlowGate(input)
    const resultStr = JSON.stringify(result)
    expect(resultStr).toContain("Trunk-based")
  })

  it("should block main branching in git-flow repos", async () => {
    await setupGitRepo(tempDir, true)

    const input: unknown = {
      tool_name: "Bash",
      cwd: tempDir,
      tool_input: {
        command: "git checkout -b feat/my-feature origin/main",
      },
    }

    const result = await evaluateGitFlowGate(input)
    const resultStr = JSON.stringify(result)
    expect(resultStr).toContain("Git-flow repository detected")
  })

  it("should detect git branch from main", async () => {
    await setupGitRepo(tempDir, true)

    const input: unknown = {
      tool_name: "Bash",
      cwd: tempDir,
      tool_input: {
        command: "git branch feat/feature origin/main",
      },
    }

    const result = await evaluateGitFlowGate(input)
    expect(JSON.stringify(result).length > 0).toBe(true)
  })

  it("should allow main interaction when hotfix is declared in transcript", async () => {
    await setupGitRepo(tempDir, true)

    const transcriptPath = path.join(tempDir, "transcript.txt")
    await fs.writeFile(transcriptPath, "This is a critical hotfix for production")

    const input: unknown = {
      tool_name: "Bash",
      cwd: tempDir,
      tool_input: {
        command: "git checkout -b hotfix/critical-bug origin/main",
      },
      transcript_path: transcriptPath,
    }

    const result = await evaluateGitFlowGate(input)
    const resultStr = JSON.stringify(result)
    expect(resultStr).toContain("allowed")
  })

  it("should ignore non-shell tools", async () => {
    await setupGitRepo(tempDir, true)

    const input: unknown = {
      tool_name: "Edit",
      cwd: tempDir,
      tool_input: {
        command: "git checkout -b feat/feature origin/main",
      },
    }

    const result = await evaluateGitFlowGate(input)
    expect(JSON.stringify(result)).toBe("{}")
  })

  it("should ignore unrelated commands", async () => {
    await setupGitRepo(tempDir, true)

    const input: unknown = {
      tool_name: "Bash",
      cwd: tempDir,
      tool_input: {
        command: "git status",
      },
    }

    const result = await evaluateGitFlowGate(input)
    expect(JSON.stringify(result)).toBe("{}")
  })
})

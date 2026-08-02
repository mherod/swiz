import { stat } from "node:fs/promises"
import { join } from "node:path"
import { getHomeDir } from "../src/home.ts"

/**
 * Diagnostic probe to inspect Antigravity CLI session transcript files under
 * ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl
 */
async function main() {
  const home = getHomeDir()
  const sessionId = process.argv[2]
  if (!sessionId) {
    console.error("Usage: bun scripts/debug-antigravity-transcript-discovery.ts <session-id>")
    process.exitCode = 1
    return
  }

  const sessionDir = join(home, ".gemini", "antigravity-cli", "brain", sessionId)

  console.log("Inspecting session dir:", sessionDir)

  const logFile = join(sessionDir, ".system_generated", "logs", "transcript.jsonl")
  try {
    const s = await stat(logFile)
    console.log(`[FOUND] transcript.jsonl (${s.size} bytes, modified: ${s.mtime.toISOString()})`)

    // Read first line to verify JSONL structure
    const file = Bun.file(logFile)
    const text = await file.text()
    const firstLine = text.split("\n")[0]
    if (firstLine) {
      const parsed = JSON.parse(firstLine)
      console.log("First Entry Type:", parsed.type)
      console.log("First Entry Source:", parsed.source)
      console.log(
        "Content Preview:",
        String(parsed.content || "")
          .slice(0, 100)
          .replace(/\n/g, " ")
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("Failed to read transcript.jsonl:", message)
  }
}

await main()

// Tool implementations for auto-reply model to examine files
import { tool } from "ai"
import { z } from "zod"

export const readTool = tool({
  description: "Read the contents of a file",
  inputSchema: z.object({
    file_path: z.string().describe("Path to the file to read"),
    offset: z.number().optional().describe("Starting line number (1-based)"),
    limit: z.number().optional().describe("Maximum number of lines to read"),
  }),
  execute: async ({ file_path, offset, limit }) => {
    try {
      const file = Bun.file(file_path)
      if (!(await file.exists())) {
        return { error: `File not found: ${file_path}` }
      }
      const lines = (await file.text()).split("\n")
      const start = offset ? offset - 1 : 0
      const end = limit ? start + limit : lines.length
      return {
        content: lines.slice(start, end).join("\n"),
        totalLines: lines.length,
        shown: `${start + 1}-${Math.min(end, lines.length)}`,
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

export const grepTool = tool({
  description: "Search for a pattern in files using ripgrep",
  inputSchema: z.object({
    pattern: z.string().describe("The regex pattern to search for"),
    path: z.string().optional().describe("Directory or file path to search in"),
    glob: z.string().optional().describe("Glob filter for files (e.g., '*.ts')"),
    maxResults: z.number().optional().describe("Maximum number of results (default: 20)"),
  }),
  execute: async ({ pattern, path, glob, maxResults = 20 }) => {
    try {
      const args = [
        "rg",
        "--line-number",
        "--no-heading",
        "--color=never",
        "-m",
        String(maxResults),
      ]
      if (glob) args.push("--glob", glob)
      args.push(pattern)
      if (path) args.push(path)
      const proc = Bun.spawn(args, {
        cwd: process.cwd(),
        stderr: "pipe",
        stdout: "pipe",
      })
      const output = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited
      if (proc.exitCode === 0) {
        return { matches: output.trim(), count: output.split("\n").filter(Boolean).length }
      } else if (proc.exitCode === 1) {
        return { matches: "", count: 0, message: "No matches found" }
      } else {
        return { error: stderr || `ripgrep failed with exit code ${proc.exitCode}` }
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})

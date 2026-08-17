import { findCodexSessions } from "../src/transcript-sessions-discovery.ts"

interface DescriptorSnapshot {
  codexTranscriptDescriptors: number
  maxDuplicateCount: number
  openDescriptors: number
  uniqueCodexTranscripts: number
}

async function readOpenFiles(): Promise<string[]> {
  const proc = Bun.spawn(["lsof", "-p", String(process.pid)], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`lsof failed (${exitCode}): ${stderr.trim()}`)
  }
  return stdout.split("\n").filter(Boolean)
}

async function snapshotDescriptors(): Promise<DescriptorSnapshot> {
  const rows = await readOpenFiles()
  const codexPaths = rows
    .map((row) => row.match(/(\/Users\/[^\s]+\/\.codex\/sessions\/[^\s]+\.jsonl)$/)?.[1])
    .filter((path): path is string => Boolean(path))
  const counts = new Map<string, number>()
  for (const path of codexPaths) counts.set(path, (counts.get(path) ?? 0) + 1)
  return {
    openDescriptors: Math.max(0, rows.length - 1),
    codexTranscriptDescriptors: codexPaths.length,
    uniqueCodexTranscripts: counts.size,
    maxDuplicateCount: Math.max(0, ...counts.values()),
  }
}

const target = process.argv[2] ?? process.cwd()
const iterations = Math.max(1, Number.parseInt(process.argv[3] ?? "3", 10) || 3)

console.error("--- codex session discovery descriptor probe ---")
console.error(JSON.stringify({ target, iterations, pid: process.pid }))
console.error(JSON.stringify({ phase: "baseline", ...(await snapshotDescriptors()) }))

for (let iteration = 1; iteration <= iterations; iteration++) {
  const startedAt = performance.now()
  const sessions = await findCodexSessions(target, undefined, 10)
  const elapsedMs = performance.now() - startedAt
  console.error(
    JSON.stringify({
      phase: "after-scan",
      iteration,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      sessions: sessions.length,
      ...(await snapshotDescriptors()),
    })
  )
}

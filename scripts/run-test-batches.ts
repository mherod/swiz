import { resolve } from "node:path"

/**
 * Keep reporting in batches, but give each file a fresh Bun process: reused
 * isolated workers can stall on subprocess exits even within an 80-file batch.
 */
const BATCH_SIZE = 80

export function discoverTestFiles(cwd: string): string[] {
  return [
    ...new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}").scanSync({
      cwd,
      onlyFiles: true,
    }),
  ]
    .filter((path) => !path.split("/").includes("node_modules"))
    .sort()
    .map((path) => resolve(cwd, path))
}

async function runBunTest(file: string, timeoutMs: number): Promise<number> {
  const proc = Bun.spawn(
    [process.execPath, "test", "--reporter=dots", `--timeout=${timeoutMs}`, file],
    { stdin: "inherit", stdout: "pipe", stderr: "pipe" }
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  await Bun.write(Bun.stderr, `${file}\n${stdout}${stderr}`)
  return proc.exitCode ?? 1
}

/** Run at most four files at once; drain active files before returning any failure. */
export async function runTestFiles(
  files: string[],
  runFile: (file: string) => Promise<number>
): Promise<number> {
  let next = 0
  let exitCode = 0
  const worker = async () => {
    while (exitCode === 0 && next < files.length) {
      const file = files[next++]!
      try {
        const code = await runFile(file)
        if (code !== 0 && exitCode === 0) exitCode = code
      } catch (error) {
        if (exitCode === 0) exitCode = 1
        throw error
      }
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, files.length) }, worker)
  )
  for (const result of results) {
    if (result.status === "rejected") throw result.reason
  }
  return exitCode
}

export async function runTestBatches(
  files: string[],
  runBatch: (batch: string[]) => Promise<number> = (batch) =>
    runTestFiles(batch, (file) => runBunTest(file, 60_000))
): Promise<number> {
  if (files.length === 0) throw new Error("No test files selected")
  for (let offset = 0; offset < files.length; offset += BATCH_SIZE) {
    const batch = files.slice(offset, offset + BATCH_SIZE)
    console.error(
      `Test batch ${offset / BATCH_SIZE + 1}/${Math.ceil(files.length / BATCH_SIZE)}: ${batch.length} files`
    )
    const exitCode = await runBatch(batch)
    if (exitCode !== 0) return exitCode
  }
  return 0
}

/** No selection means the complete suite, including newly created, untracked tests. */
export async function runTestSuite(args: string[], cwd = process.cwd()): Promise<number> {
  let timeoutMs = 5000
  const files: string[] = []
  for (const arg of args) {
    if (arg.startsWith("--timeout=")) {
      timeoutMs = Number(arg.slice("--timeout=".length))
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout must be a positive integer in milliseconds")
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`Unsupported test runner option: ${arg}`)
    } else {
      files.push(resolve(cwd, arg))
    }
  }
  return runTestBatches(files.length ? files : discoverTestFiles(cwd), (batch) =>
    runTestFiles(batch, (file) => runBunTest(file, timeoutMs))
  )
}

if (import.meta.main) {
  process.exitCode = await runTestSuite(process.argv.slice(2))
}

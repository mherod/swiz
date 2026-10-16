import { resolve } from "node:path"

/**
 * Long-lived isolated Bun workers can stall during full-suite runs. Recycle the
 * pool after 80 files while retaining four concurrent workers and every selected test.
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

async function runBunTests(files: string[], timeoutMs: number): Promise<number> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "test",
      "--reporter=dots",
      ...(files.length > 1 ? ["--parallel=4"] : []),
      `--timeout=${timeoutMs}`,
      ...files,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
  )
  await proc.exited
  return proc.exitCode ?? 1
}

export async function runTestBatches(
  files: string[],
  runBatch: (batch: string[]) => Promise<number> = (batch) => runBunTests(batch, 60_000)
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
    runBunTests(batch, timeoutMs)
  )
}

if (import.meta.main) {
  process.exitCode = await runTestSuite(process.argv.slice(2))
}

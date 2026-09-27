/** Keep isolated Bun workers short-lived without changing the selected tests. */
const BATCH_SIZE = 80

async function runBunTests(files: string[]): Promise<number> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "test",
      "--reporter=dots",
      ...(files.length > 1 ? ["--parallel=4"] : []),
      "--timeout=60000",
      ...files,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
  )
  await proc.exited
  return proc.exitCode ?? 1
}

export async function runTestBatches(
  files: string[],
  runBatch: (batch: string[]) => Promise<number> = runBunTests
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

if (import.meta.main) {
  process.exitCode = await runTestBatches(process.argv.slice(2))
}

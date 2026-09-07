import { join, resolve } from "node:path"
import ts from "typescript"

/** Include imported declarations so cached consumers cannot retain stale type diagnostics. */
export async function createTypeFingerprint(root: string): Promise<string> {
  const configPath = join(root, "tsconfig.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n")
    )
  }

  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(
    JSON.stringify({
      version: ts.version,
      runtime: Bun.version,
      options: parsed.options,
      roots: parsed.fileNames,
    })
  )
  for (const file of program.getSourceFiles()) {
    hash.update(`${file.fileName}\0`)
    hash.update(file.text)
    hash.update("\0")
  }
  for (const name of ["tsconfig.json", "package.json", "bun.lock", "bun.lockb"]) {
    const file = Bun.file(join(root, name))
    hash.update(`${name}\0`)
    if (await file.exists()) hash.update(await file.arrayBuffer())
    hash.update("\0")
  }
  return hash.digest("hex")
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..")
  const args = process.argv.slice(2)
  /** Custom CLI options and rule profiling always perform a fresh lint. */
  const cache = args.length === 0 && !process.env.TIMING
  const fingerprint = cache ? await createTypeFingerprint(root) : ""
  /** Release the temporary dependency graph before ESLint builds its own type checker. */
  Bun.gc(true)
  const proc = Bun.spawn(
    [
      process.execPath,
      join(root, "node_modules", "eslint", "bin", "eslint.js"),
      ".",
      "--max-warnings=0",
      ...args,
      ...(cache ? ["--cache", "--cache-strategy=content"] : ["--no-cache"]),
    ],
    {
      cwd: root,
      env: { ...process.env, SWIZ_ESLINT_TYPE_FINGERPRINT: fingerprint },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  )
  process.exitCode = await proc.exited
}

if (import.meta.main) {
  void main().catch((error: Error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

import { join, relative, resolve } from "node:path"
import ts from "typescript"
import { listChangedFiles } from "./changed-files.ts"

const LINTABLE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/
const IGNORED_PREFIX_RE = /^(?:node_modules|\.swiz|coverage|dist)(?:\/|\\)/
export const MAX_FAST_PREPASS_FILES = 50

/** Filter changed file paths down to existing, non-ignored ESLint targets within `root`. */
export function filterLintableChangedFiles(root: string, files: readonly string[]): string[] {
  const normalizedRoot = resolve(root)
  const result: string[] = []
  for (const filePath of files) {
    const abs = resolve(normalizedRoot, filePath)
    const rel = relative(normalizedRoot, abs)
    if (!rel || rel.startsWith("..")) continue
    if (!LINTABLE_EXT_RE.test(rel) || rel.endsWith(".d.ts")) continue
    if (IGNORED_PREFIX_RE.test(rel)) continue
    result.push(abs)
  }
  return result
}

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

function spawnEslint(
  root: string,
  targetsAndArgs: string[],
  env: Record<string, string | undefined>
): Promise<number> {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(root, "node_modules", "eslint", "bin", "eslint.js"),
      "--max-warnings=0",
      ...targetsAndArgs,
    ],
    {
      cwd: root,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  )
  return proc.exited
}

function parseLintCliArgs(args: string[]): { failFast: boolean; eslintArgs: string[] } {
  let failFast = true
  const eslintArgs: string[] = []
  for (const arg of args) {
    if (arg === "--all" || arg === "--no-fail-fast") {
      failFast = false
    } else {
      eslintArgs.push(arg)
    }
  }
  return { failFast, eslintArgs }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..")
  const { failFast, eslintArgs } = parseLintCliArgs(process.argv.slice(2))
  /** Custom CLI options and rule profiling always perform a fresh lint. */
  const cache = eslintArgs.length === 0 && !process.env.TIMING

  if (failFast && cache) {
    const changed = filterLintableChangedFiles(root, listChangedFiles(root))
    if (changed.length > 0 && changed.length <= MAX_FAST_PREPASS_FILES) {
      const prepassCode = await spawnEslint(
        root,
        ["--no-cache", "--no-warn-ignored", ...changed],
        process.env
      )
      if (prepassCode !== 0) {
        process.stderr.write(
          "Stopped after failing changed file(s) (fail-fast). Run `bun run lint:eslint -- --all` for all errors.\n"
        )
        process.exitCode = prepassCode
        return
      }
    }
  }

  const fingerprint = cache ? await createTypeFingerprint(root) : ""
  /** Release the temporary dependency graph before ESLint builds its own type checker. */
  Bun.gc(true)
  process.exitCode = await spawnEslint(
    root,
    [".", ...eslintArgs, ...(cache ? ["--cache", "--cache-strategy=content"] : ["--no-cache"])],
    { ...process.env, SWIZ_ESLINT_TYPE_FINGERPRINT: fingerprint }
  )
}

if (import.meta.main) {
  void main().catch((error: Error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

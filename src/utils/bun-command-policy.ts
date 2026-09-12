import { dirname, join, resolve } from "node:path"
import { detectPackageManagerDetails, type PackageManagerDetection } from "./package-detection.ts"

const RUNTIME_FLAGS = new Set([
  "--hot",
  "--watch",
  "--smol",
  "--no-clear-screen",
  "--no-install",
  "--no-env-file",
  "--bun",
  "-b",
  "--silent",
  "--if-present",
])
const VALUE_FLAGS = new Set([
  "--cwd",
  "--config",
  "-c",
  "--preload",
  "--require",
  "--import",
  "-r",
  "--env-file",
])
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"])
const VERSION_FLAGS = new Set(["-v", "--version", "--revision", "-h", "--help"])
const FILE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/i
// PreToolUse sees shell text before expansion. A variable plus a fixed file suffix
// expresses runtime intent without reading the daemon's unrelated environment.
const SYMBOLIC_FILE_PATH = /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})\/(?:[\w@+.-]+\/)*[\w@+.-]+$/
const BUILTIN_COMMANDS = new Set([
  "test",
  "build",
  "install",
  "i",
  "add",
  "a",
  "remove",
  "rm",
  "update",
  "audit",
  "outdated",
  "link",
  "unlink",
  "publish",
  "patch",
  "pm",
  "info",
  "why",
  "init",
  "create",
  "c",
  "x",
  "exec",
])

interface BunInvocation {
  cwd: string
  entry: string
  run: boolean
  runtime: boolean
  packageOnly: boolean
  rest: string[]
}

function optionValue(args: string[], index: number): { value: string | undefined; next: number } {
  const token = args[index]!
  const equals = token.indexOf("=")
  return equals < 0
    ? { value: args[index + 1], next: index + 1 }
    : { value: token.slice(equals + 1), next: index }
}

function parseBunInvocation(args: string[], cwd: string): BunInvocation {
  const result: BunInvocation = {
    cwd: resolve(cwd),
    entry: "",
    run: false,
    runtime: false,
    packageOnly: false,
    rest: [],
  }
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!
    if (token === "run" && !result.run) {
      result.run = true
      continue
    }
    if (token === "--") {
      result.entry = args[index + 1] ?? ""
      result.rest = args.slice(index + 2)
      break
    }
    if (!token.startsWith("-")) {
      result.entry = token
      result.rest = args.slice(index + 1)
      break
    }
    index = consumeBunOption(args, index, result)
  }
  return result
}

function consumeBunOption(args: string[], index: number, result: BunInvocation): number {
  const token = args[index]!
  const flag = token.split("=")[0]!
  if (VERSION_FLAGS.has(token)) {
    result.runtime = true
    return index
  }
  if (RUNTIME_FLAGS.has(token)) return index
  if (!VALUE_FLAGS.has(flag) && !EVAL_FLAGS.has(flag)) {
    result.packageOnly = true
    return index
  }
  const { value, next } = optionValue(args, index)
  if (value === undefined) result.packageOnly = true
  else if (flag === "--cwd") result.cwd = resolve(result.cwd, value)
  else if (EVAL_FLAGS.has(flag)) result.runtime = true
  return next
}

async function hasPackageScript(cwd: string, name: string): Promise<boolean> {
  let dir = cwd
  while (true) {
    const file = Bun.file(join(dir, "package.json"))
    if (await file.exists()) {
      try {
        const pkg = await file.json()
        return typeof pkg?.scripts?.[name] === "string"
      } catch {
        return false
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

function packageTargetCwd(args: string[], cwd: string): string {
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!
    if (token === "--") break
    if (token !== "--cwd" && !token.startsWith("--cwd=")) continue
    const { value, next } = optionValue(args, index)
    if (value !== undefined) cwd = resolve(cwd, value)
    index = next
  }
  return cwd
}

function isGlobalBunOperation(args: string[], entry: string): boolean {
  const end = args.indexOf("--")
  const flags = end < 0 ? args : args.slice(0, end)
  if (!flags.some((arg) => arg === "-g" || arg === "--global")) return false
  if (["add", "install", "remove"].includes(entry)) return true
  return entry === "pm" && flags[flags.indexOf("pm") + 1] === "bin"
}

export function packagePolicyContext(
  detection: PackageManagerDetection | null,
  cwd: string
): string {
  const source = detection
    ? `${detection.packageManager} from ${detection.source} at ${detection.root}`
    : "no package-manager signals"
  return `Package policy: ${source}. Target cwd: ${cwd}.`
}

export interface BunCommandPolicy {
  intent: "runtime" | "package" | "global"
  cwd: string
  context: string
  denial: string | null
}

/** Shared by the shell shim and PreToolUse: Bun's runtime does not own npm dependencies. */
export async function evaluateBunCommandPolicy(
  args: string[],
  cwd: string
): Promise<BunCommandPolicy> {
  const invocation = parseBunInvocation(args, cwd)
  // Options after a file or package-script entry belong to that entry, not Bun.
  if (!invocation.run && BUILTIN_COMMANDS.has(invocation.entry)) {
    invocation.cwd = packageTargetCwd(invocation.rest, invocation.cwd)
  }
  const runtime = await isBunRuntime(invocation)
  const targetCwd = invocation.cwd
  const detection = await detectPackageManagerDetails(targetCwd)
  const intent = runtime
    ? "runtime"
    : !invocation.run && isGlobalBunOperation(args, invocation.entry)
      ? "global"
      : "package"
  const context = packagePolicyContext(detection, targetCwd)
  const denied = intent === "package" && detection && detection.packageManager !== "bun"
  return {
    intent,
    cwd: targetCwd,
    context,
    denial: denied
      ? `Use ${detection.packageManager} for dependency operations and package.json scripts. ${context} ` +
        `Bun file execution, evaluation and version checks use the Bun runtime independently.`
      : null,
  }
}

async function isBunRuntime(invocation: BunInvocation): Promise<boolean> {
  if (invocation.packageOnly) return false
  if (invocation.runtime) return true
  if (!invocation.run && invocation.entry === "test") return true
  if (!FILE_EXTENSION.test(invocation.entry)) return false
  if (invocation.run && (await hasPackageScript(invocation.cwd, invocation.entry))) return false
  if (invocation.entry.startsWith("$")) {
    return SYMBOLIC_FILE_PATH.test(invocation.entry) && !invocation.entry.split("/").includes("..")
  }
  return Bun.file(resolve(invocation.cwd, invocation.entry)).exists()
}

async function runShellPolicy(): Promise<void> {
  const cwd = process.argv[2]
  if (!cwd) {
    process.exitCode = 1
    return
  }
  const result = await evaluateBunCommandPolicy(process.argv.slice(3), cwd)
  process.stdout.write(result.denial ? `deny:${result.denial}` : "allow")
}

if (import.meta.main) void runShellPolicy()

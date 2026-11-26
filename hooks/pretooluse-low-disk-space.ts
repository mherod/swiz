#!/usr/bin/env bun

/**
 * PreToolUse hook: Block disk-heavy dev, build, typecheck, and lint commands
 * when the filesystem has less than 1 GiB of free space.
 *
 * Covers `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, and common
 * equivalents (other package managers, monorepo orchestrators, task runners,
 * direct compilers/bundlers/linters, `node_modules/.bin` paths, command
 * wrappers, nested shells, and command substitutions) so agents cannot bypass
 * the check via escape hatches.
 *
 * Dual-mode: exports a SwizShellHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import { statfs } from "node:fs/promises"
import { basename } from "node:path"
import { formatActionPlan } from "../src/action-plan.ts"
import { extractExecutableSubcommands, normalizeCommand } from "../src/command-utils.ts"
import { resolveShellCwd } from "../src/cwd.ts"
import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizShellHook,
} from "../src/SwizHook.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { type ShellHeredoc, splitHeredocBodies } from "../src/utils/shell-heredocs.ts"
import { splitShellSegments, tokenizeShellSegment } from "../src/utils/shell-patterns.ts"

/** Minimum free disk space required before running dev/build/typecheck/lint commands (1 GiB). */
export const MIN_FREE_DISK_BYTES = 1024 * 1024 * 1024

export type DiskHeavyCategory = "dev" | "build" | "typecheck" | "lint"

export interface MatchedDiskHeavyCommand {
  category: DiskHeavyCategory
  invocation: string
}

export type FreeDiskBytesReader = (dir: string) => Promise<number | null>

const MAX_RECURSION_DEPTH = 6
const SHELL_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECT_TOKEN_RE = /^(\d*(>>|>&|<&|>\||<>|>|<)|&>>?)(.*)$/
const HEREDOC_SUBCOMMAND_RE = /(?<!\\)(?:\\\\)*(?:\$\(([^()]*)\)|`([^`]*)`)/g
const PATH_PREFIX_SUB_RE = /(?:"(?:\$\([^()]*\)|`[^`]*`)"|\$\([^()]*\)|`[^`]*`)(?=\/)/g
const SHELL_KEYWORDS = new Set([
  "!",
  "{",
  "(",
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
])
const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])

const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  exec: new Set(["-a"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "-P", "-u"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "-D", "--chdir", "-p", "-h", "-r", "-t"]),
  doas: new Set(["-u", "-C"]),
  caffeinate: new Set(["-t", "-w"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  gtimeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  watch: new Set(["-n", "--interval", "-d", "--differences"]),
  dotenv: new Set(["-e", "-v", "-p", "-c"]),
  dotenvx: new Set(["-f", "--env-file", "-fk", "--env-keys-file", "-e", "--env"]),
  xargs: new Set(["-I", "-J", "-L", "-n", "-P", "-s", "-d", "-E", "--max-args", "--max-procs"]),
}

const SIMPLE_WRAPPERS = new Set([
  "builtin",
  "caffeinate",
  "chronic",
  "command",
  "corepack",
  "doas",
  "dotenv",
  "dotenvx",
  "env",
  "exec",
  "gtimeout",
  "ionice",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "unbuffer",
  "watch",
  "xargs",
  "xcrun",
])

const PM_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  pnpm: new Set([
    "-C",
    "--dir",
    "--filter",
    "-F",
    "--filter-prod",
    "--workspace-concurrency",
    "--reporter",
    "--loglevel",
    "--config",
    "--store-dir",
    "--virtual-store-dir",
    "--prefix",
    "--package",
    "-p",
  ]),
  npm: new Set([
    "--prefix",
    "-C",
    "-w",
    "--workspace",
    "--loglevel",
    "--registry",
    "--cache",
    "--userconfig",
    "-p",
    "--package",
  ]),
  yarn: new Set(["--cwd", "--mode", "--registry", "-p", "--package"]),
  bun: new Set(["--cwd", "--filter", "-F", "--config", "-c", "--env-file", "--preload", "-r"]),
  npx: new Set(["-p", "--package", "--registry", "--cache", "--userconfig"]),
  pnpx: new Set(["-p", "--package", "--registry", "--cache", "--userconfig"]),
  bunx: new Set(["-p", "--package"]),
  turbo: new Set([
    "--filter",
    "-F",
    "--concurrency",
    "--cache-dir",
    "--cwd",
    "--env-mode",
    "--framework-inference",
    "--log-order",
    "--log-prefix",
    "--output-logs",
    "--remote-cache-timeout",
    "--summarize",
    "--team",
    "--token",
    "--api",
    "--ui",
    "--verbosity",
  ]),
  nx: new Set([
    "-p",
    "--projects",
    "-t",
    "--target",
    "--targets",
    "-c",
    "--configuration",
    "--base",
    "--head",
  ]),
  lerna: new Set(["--scope", "--ignore", "--since", "--concurrency", "--loglevel"]),
  moon: new Set(["--concurrency", "--log", "--cache"]),
  make: new Set([
    "-f",
    "--file",
    "--makefile",
    "-C",
    "--directory",
    "-j",
    "--jobs",
    "-I",
    "-o",
    "-W",
  ]),
  just: new Set(["-f", "--justfile", "-d", "--working-directory", "--set"]),
  task: new Set(["-t", "--taskfile", "-d", "--dir", "-o", "--output"]),
  node: new Set(["-r", "--require", "--import", "--loader", "--conditions", "-C", "--env-file"]),
}

const ALWAYS_TYPECHECK_TOOLS = new Set([
  "tsc",
  "tsgo",
  "vue-tsc",
  "svelte-check",
  "pyright",
  "basedpyright",
  "mypy",
])

const ALWAYS_LINT_TOOLS = new Set([
  "eslint",
  "eslint_d",
  "oxlint",
  "stylelint",
  "tslint",
  "golangci-lint",
])

const ALWAYS_BUILD_TOOLS = new Set([
  "webpack",
  "webpack-cli",
  "esbuild",
  "rollup",
  "tsup",
  "tsdown",
  "unbuild",
  "microbundle",
  "pkgroll",
  "swc",
  "babel",
  "build-storybook",
])

const ALWAYS_DEV_TOOLS = new Set(["webpack-dev-server", "start-storybook", "turbopack"])

const SUBCOMMAND_TOOL_RULES: Record<string, Readonly<Record<string, DiskHeavyCategory>>> = {
  next: { dev: "dev", build: "build", lint: "lint", typegen: "typecheck" },
  nuxt: { dev: "dev", build: "build", generate: "build", prepare: "build", typecheck: "typecheck" },
  nuxi: { dev: "dev", build: "build", generate: "build", prepare: "build", typecheck: "typecheck" },
  astro: { dev: "dev", preview: "dev", build: "build", check: "typecheck" },
  remix: { dev: "dev", "vite:dev": "dev", build: "build", "vite:build": "build" },
  "react-router": { dev: "dev", build: "build", typegen: "typecheck" },
  "svelte-kit": { sync: "build" },
  rsbuild: { dev: "dev", preview: "dev", build: "build" },
  storybook: { dev: "dev", build: "build" },
  gatsby: { develop: "dev", serve: "dev", build: "build" },
  docusaurus: { start: "dev", serve: "dev", build: "build" },
  vitepress: { dev: "dev", preview: "dev", build: "build" },
  expo: {
    start: "dev",
    export: "build",
    prebuild: "build",
    "run:ios": "build",
    "run:android": "build",
  },
  ng: { serve: "dev", s: "dev", build: "build", b: "build", lint: "lint" },
  nest: { start: "dev", build: "build" },
  biome: { check: "lint", lint: "lint", ci: "lint" },
  ruff: { check: "lint" },
  cargo: { build: "build", b: "build", check: "typecheck", c: "typecheck", clippy: "lint" },
  go: { build: "build", vet: "lint" },
  dotnet: { build: "build" },
  mvn: { compile: "build", package: "build", install: "build", verify: "build" },
  mvnw: { compile: "build", package: "build", install: "build", verify: "build" },
}

const PACKAGE_TO_BINARY: Readonly<Record<string, string>> = {
  "@biomejs/biome": "biome",
  "@typescript/native-preview": "tsgo",
  typescript: "tsc",
  "@angular/cli": "ng",
  "@nestjs/cli": "nest",
}

const DEV_SCRIPT_RE = /^(?:dev(?:[:_-].+)?|.+[:_-]dev|serve(?:[:_-].+)?|develop(?:[:_-].+)?)$/
const BUILD_SCRIPT_RE = /^(?:build(?:[:_-].+)?|.+[:_-]build|compile(?:[:_-].+)?)$/
const TYPECHECK_SCRIPT_RE =
  /^(?:type[-_]?check(?:[:_-].+)?|.+[:_-]type[-_]?check|check[:_-]types?|types?[:_-]check|ts[:_-]check|check[:_-]ts|tsc(?:[:_-].+)?)$/
const LINT_SCRIPT_RE = /^(?:lint(?:[:_-].+)?|.+[:_-]lint|eslint|oxlint|biome)$/

/** Classify a package script or task target name into one of the four guarded categories. */
export function classifyScriptName(
  rawName: string,
  opts: { allowBareCheck?: boolean } = {}
): DiskHeavyCategory | null {
  const name = rawName.trim().toLowerCase()
  if (!name) return null
  if (TYPECHECK_SCRIPT_RE.test(name)) return "typecheck"
  if (LINT_SCRIPT_RE.test(name)) return "lint"
  if (opts.allowBareCheck && name === "check") return "lint"
  if (BUILD_SCRIPT_RE.test(name)) return "build"
  if (DEV_SCRIPT_RE.test(name)) return "dev"
  return null
}

function stripRedirections(tokens: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const match = REDIRECT_TOKEN_RE.exec(tokens[i]!)
    if (!match) kept.push(tokens[i]!)
    else if (!match[3]) i++
  }
  return kept
}

function stripOuterGrouping(tokens: string[]): string[] {
  const cleaned = tokens.map((t) => t)
  while (cleaned.length > 0 && SHELL_KEYWORDS.has(cleaned[0]!)) cleaned.shift()
  if (cleaned.length > 0) {
    cleaned[0] = cleaned[0]!.replace(/^[({]+/, "")
    if (!cleaned[0]) cleaned.shift()
  }
  while (cleaned.length > 0) {
    const last = cleaned.length - 1
    cleaned[last] = cleaned[last]!.replace(/[)}]+$/, "")
    if (!cleaned[last]) cleaned.pop()
    else break
  }
  return cleaned
}

function isHelpOrVersionQuery(args: string[], allowShortV: boolean): boolean {
  const beforeDash = args.includes("--") ? args.slice(0, args.indexOf("--")) : args
  if (beforeDash.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-V")) {
    return true
  }
  return allowShortV && beforeDash.length === 1 && beforeDash[0] === "-v"
}

function skipOptions(tokens: string[], start: number, valueFlags?: ReadonlySet<string>): number {
  let index = start
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === "--") return index + 1
    if (!token.startsWith("-") || token === "-") break
    index++
    if (!token.includes("=") && valueFlags?.has(token) && index < tokens.length) index++
  }
  return index
}

function shellCommandFlagBody(tokens: string[], start: number): string | null {
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === "--") break
    if (token === "--command") return tokens[i + 1] ?? null
    if (token.startsWith("--command=")) return token.slice("--command=".length) || null
    if (/^-[^-]*c/.test(token)) return tokens[i + 1] ?? null
    if (!token.startsWith("-")) break
  }
  return null
}

function extractCallOptionBody(tokens: string[], start: number): string | null {
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === "--") break
    if (token === "-c" || token === "--call") return tokens[i + 1] ?? null
    if (token.startsWith("--call=")) return token.slice("--call=".length) || null
    if (!token.startsWith("-")) break
  }
  return null
}

function normalizePackageBinary(spec: string): string {
  const trimmed = spec.trim()
  const withoutVersion = trimmed.startsWith("@")
    ? trimmed.replace(/^(@[^/]+\/[^@]+)@.+$/, "$1")
    : trimmed.replace(/@.+$/, "")
  const mapped = PACKAGE_TO_BINARY[withoutVersion.toLowerCase()]
  if (mapped) return mapped
  const base = basename(withoutVersion).replace(/\.(?:[cm]?js|ts|cmd|ps1)$/i, "")
  return base.toLowerCase()
}

function nodeModulesBinaryName(scriptPath: string): string | null {
  const normalized = scriptPath.replaceAll("\\", "/")
  if (!normalized.includes("node_modules/")) return null
  const binMatch = normalized.match(/node_modules\/\.bin\/([^/]+)$/)
  if (binMatch?.[1]) return normalizePackageBinary(binMatch[1])
  if (normalized.includes("node_modules/@biomejs/biome/")) return "biome"
  if (normalized.includes("node_modules/typescript/")) return "tsc"
  if (normalized.includes("node_modules/@typescript/native-preview/")) return "tsgo"
  return normalizePackageBinary(normalized)
}

function extractEnvSplitString(tokens: string[], start: number): string | null {
  for (let i = start; i < tokens.length && tokens[i]!.startsWith("-"); i++) {
    const opt = tokens[i]!
    if (opt === "-S" || opt === "--split-string") return tokens[i + 1] ?? ""
    if (opt.startsWith("--split-string=")) return opt.slice("--split-string=".length)
  }
  return null
}

function isCommandLookup(tokens: string[], start: number): boolean {
  const flags = tokens.slice(start, skipOptions(tokens, start))
  return flags.some((f) => /^-[p]*[vV]/.test(f))
}

function unwrapSingleWrapper(
  tokens: string[],
  index: number,
  execName: string
): { nextIndex: number; nestedBody?: string; abort?: boolean } | null {
  if (!SIMPLE_WRAPPERS.has(execName)) return null
  if (execName === "command" && isCommandLookup(tokens, index + 1)) {
    return { nextIndex: tokens.length, abort: true }
  }
  if (execName === "env") {
    const splitBody = extractEnvSplitString(tokens, index + 1)
    if (splitBody !== null) return { nextIndex: tokens.length, nestedBody: splitBody }
  }
  let next = skipOptions(tokens, index + 1, WRAPPER_VALUE_FLAGS[execName])
  if (execName === "timeout" || execName === "gtimeout") next++
  if (execName === "dotenvx" && tokens[next] === "run") {
    next = skipOptions(tokens, next + 1, WRAPPER_VALUE_FLAGS.dotenvx)
  }
  return { nextIndex: next }
}

function unwrapLeadingPrefixes(
  tokens: string[]
): { remaining: string[]; nestedBody?: string } | null {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (SHELL_KEYWORDS.has(token) || SHELL_ASSIGNMENT_RE.test(token)) {
      index++
      continue
    }
    const execName = basename(token).toLowerCase()
    const unwrapped = unwrapSingleWrapper(tokens, index, execName)
    if (!unwrapped) break
    if (unwrapped.abort) return null
    if (unwrapped.nestedBody !== undefined) {
      return { remaining: [], nestedBody: unwrapped.nestedBody }
    }
    index = unwrapped.nextIndex
  }
  return { remaining: tokens.slice(index) }
}

function classifyWranglerArgs(args: string[], posIdx: number): DiskHeavyCategory | null {
  const first = args[posIdx]?.toLowerCase()
  if (first === "dev") return "dev"
  if (first === "pages") return args[posIdx + 1]?.toLowerCase() === "dev" ? "dev" : null
  if (first === "deploy" || first === "build") return "build"
  return null
}

function classifyGradleArg(first: string | undefined): DiskHeavyCategory | null {
  if (!first) return null
  if (/^(?:build|assemble|compile)/i.test(first)) return "build"
  return first === "lint" || first === "check" ? "lint" : null
}

const VITE_LIKE_CLASSIFIERS: Readonly<
  Record<string, (args: string[], posIdx: number) => DiskHeavyCategory | null>
> = {
  vite: (args, posIdx) => (args[posIdx]?.toLowerCase() === "build" ? "build" : "dev"),
  parcel: (args, posIdx) => (args[posIdx]?.toLowerCase() === "build" ? "build" : "dev"),
  rspack: (args, posIdx) => {
    const first = args[posIdx]?.toLowerCase()
    return first === "serve" || first === "dev" ? "dev" : "build"
  },
  wrangler: classifyWranglerArgs,
  gradle: (args, posIdx) => classifyGradleArg(args[posIdx]?.toLowerCase()),
  gradlew: (args, posIdx) => classifyGradleArg(args[posIdx]?.toLowerCase()),
}

function classifyViteLike(cmd: string, args: string[]): DiskHeavyCategory | null {
  const classifier = VITE_LIKE_CLASSIFIERS[cmd]
  return classifier ? classifier(args, skipOptions(args, 0)) : null
}

function classifyDirectTool(cmd: string, args: string[]): DiskHeavyCategory | null {
  if (isHelpOrVersionQuery(args, true)) return null
  if (ALWAYS_TYPECHECK_TOOLS.has(cmd)) return "typecheck"
  if (ALWAYS_LINT_TOOLS.has(cmd)) return "lint"
  if (ALWAYS_BUILD_TOOLS.has(cmd)) return "build"
  if (ALWAYS_DEV_TOOLS.has(cmd)) return "dev"

  const subRule = SUBCOMMAND_TOOL_RULES[cmd]
  if (subRule) {
    const subIdx = skipOptions(args, 0)
    const sub = args[subIdx]?.toLowerCase() ?? ""
    return subRule[sub] ?? null
  }
  return classifyViteLike(cmd, args)
}

function classifyTurboArgs(args: string[]): DiskHeavyCategory | null {
  if (isHelpOrVersionQuery(args, true)) return null
  let idx = skipOptions(args, 0, PM_VALUE_FLAGS.turbo)
  if (args[idx]?.toLowerCase() === "run") {
    idx = skipOptions(args, idx + 1, PM_VALUE_FLAGS.turbo)
  }
  while (idx < args.length) {
    const token = args[idx]!
    if (token === "--") break
    if (token.startsWith("-")) {
      idx = skipOptions(args, idx, PM_VALUE_FLAGS.turbo)
      continue
    }
    const taskPart = token.includes("#") ? token.slice(token.lastIndexOf("#") + 1) : token
    const category = classifyScriptName(taskPart, { allowBareCheck: true })
    if (category) return category
    idx++
  }
  return null
}

function classifyNxTargetList(rawTargets: string): DiskHeavyCategory | null {
  for (const part of rawTargets.split(",")) {
    const target = part.includes(":") ? part.slice(part.lastIndexOf(":") + 1) : part
    const category = classifyScriptName(target, { allowBareCheck: true })
    if (category) return category
  }
  return null
}

function extractNxTargetFlag(args: string[], start: number): string | null {
  for (let i = start; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-t" || arg === "--target" || arg === "--targets") return args[i + 1] ?? ""
    const eqMatch = arg.match(/^--targets?=(.+)$/)
    if (eqMatch?.[1]) return eqMatch[1]
  }
  return null
}

function classifyNxSubcommand(sub: string, args: string[], idx: number): DiskHeavyCategory | null {
  if (sub === "run") {
    return classifyNxTargetList(args[skipOptions(args, idx + 1, PM_VALUE_FLAGS.nx)] ?? "")
  }
  if (sub.startsWith("affected:")) return classifyNxTargetList(sub.slice("affected:".length))
  if (sub === "run-many" || sub === "affected") {
    const rawTargets = extractNxTargetFlag(args, idx + 1)
    return rawTargets ? classifyNxTargetList(rawTargets) : null
  }
  return classifyScriptName(sub, { allowBareCheck: true })
}

function classifyNxArgs(args: string[]): DiskHeavyCategory | null {
  if (isHelpOrVersionQuery(args, true)) return null
  const idx = skipOptions(args, 0, PM_VALUE_FLAGS.nx)
  const sub = args[idx]?.toLowerCase()
  return sub ? classifyNxSubcommand(sub, args, idx) : null
}

function classifyLernaArgs(args: string[]): DiskHeavyCategory | null {
  if (isHelpOrVersionQuery(args, true)) return null
  const idx = skipOptions(args, 0, PM_VALUE_FLAGS.lerna)
  if (args[idx]?.toLowerCase() !== "run") return null
  const script = args[skipOptions(args, idx + 1, PM_VALUE_FLAGS.lerna)] ?? ""
  return classifyScriptName(script, { allowBareCheck: true })
}

function classifyMoonArgs(args: string[]): DiskHeavyCategory | null {
  if (isHelpOrVersionQuery(args, true)) return null
  const idx = skipOptions(args, 0, PM_VALUE_FLAGS.moon)
  const sub = args[idx]?.toLowerCase() ?? ""
  if (sub === "check") return "lint"
  if (sub !== "run") return null
  return classifyNxTargetList(args[skipOptions(args, idx + 1, PM_VALUE_FLAGS.moon)] ?? "")
}

function classifyTaskRunnerArgs(
  cmd: "make" | "just" | "task",
  args: string[]
): DiskHeavyCategory | null {
  if (isHelpOrVersionQuery(args, true)) return null
  let idx = skipOptions(args, 0, PM_VALUE_FLAGS[cmd])
  while (idx < args.length) {
    const token = args[idx]!
    if (token.startsWith("-") || SHELL_ASSIGNMENT_RE.test(token)) {
      idx = token.startsWith("-") ? skipOptions(args, idx, PM_VALUE_FLAGS[cmd]) : idx + 1
      continue
    }
    const category = classifyScriptName(token)
    if (category) return category
    idx++
  }
  return null
}

const ORCHESTRATOR_CLASSIFIERS: Readonly<
  Record<string, (args: string[]) => DiskHeavyCategory | null>
> = {
  turbo: classifyTurboArgs,
  nx: classifyNxArgs,
  lerna: classifyLernaArgs,
  moon: classifyMoonArgs,
  make: (args) => classifyTaskRunnerArgs("make", args),
  just: (args) => classifyTaskRunnerArgs("just", args),
  task: (args) => classifyTaskRunnerArgs("task", args),
}

function classifyOrchestrator(cmd: string, args: string[]): DiskHeavyCategory | null {
  const classifier = ORCHESTRATOR_CLASSIFIERS[cmd]
  return classifier ? classifier(args) : null
}

function classifyRunnerTokens(
  tokens: string[],
  valueFlags: ReadonlySet<string>,
  depth: number
): MatchedDiskHeavyCommand | null {
  if (isHelpOrVersionQuery(tokens, true)) return null
  const callBody = extractCallOptionBody(tokens, 0)
  if (callBody) return findDiskHeavyCommand(callBody, depth + 1)

  const targetIdx = skipOptions(tokens, 0, valueFlags)
  const rawTarget = tokens[targetIdx]
  if (!rawTarget) return null
  const tool = normalizePackageBinary(rawTarget)
  const rest = tokens.slice(targetIdx + 1)
  return classifyCommandTokens([tool, ...rest], depth + 1)
}

function classifyYarnTokens(args: string[], depth: number): MatchedDiskHeavyCommand | null {
  if (isHelpOrVersionQuery(args, true)) return null
  let idx = skipOptions(args, 0, PM_VALUE_FLAGS.yarn)
  const first = args[idx]?.toLowerCase() ?? ""
  if (first === "workspace") {
    idx += 2
  } else if (first === "workspaces") {
    idx++
    if (args[idx]?.toLowerCase() === "foreach") {
      idx = skipOptions(args, idx + 1, PM_VALUE_FLAGS.yarn)
    }
  }
  return classifyPmSubcommand("yarn", args.slice(idx), depth)
}

function classifyNodeTokens(args: string[], depth: number): MatchedDiskHeavyCommand | null {
  if (isHelpOrVersionQuery(args, true)) return null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--run" && args[i + 1]) {
      const category = classifyScriptName(args[i + 1]!, { allowBareCheck: true })
      if (category) return { category, invocation: `node --run ${args[i + 1]}` }
    }
    if (arg.startsWith("--run=")) {
      const script = arg.slice("--run=".length)
      const category = classifyScriptName(script, { allowBareCheck: true })
      if (category) return { category, invocation: `node --run=${script}` }
    }
  }
  const scriptIdx = skipOptions(args, 0, PM_VALUE_FLAGS.node)
  const scriptPath = args[scriptIdx]
  if (!scriptPath) return null
  const tool = nodeModulesBinaryName(scriptPath)
  if (!tool) return null
  return classifyCommandTokens([tool, ...args.slice(scriptIdx + 1)], depth + 1)
}

const DENO_SUBCOMMANDS: Readonly<Record<string, DiskHeavyCategory>> = {
  lint: "lint",
  check: "typecheck",
  compile: "build",
  bundle: "build",
}

function classifyDenoTokens(args: string[]): MatchedDiskHeavyCommand | null {
  if (isHelpOrVersionQuery(args, true)) return null
  const idx = skipOptions(args, 0)
  const sub = args[idx]?.toLowerCase() ?? ""
  const directCategory = DENO_SUBCOMMANDS[sub]
  if (directCategory) return { category: directCategory, invocation: `deno ${sub}` }
  if (sub !== "task") return null
  const taskName = args[skipOptions(args, idx + 1)] ?? ""
  const category = classifyScriptName(taskName, { allowBareCheck: true })
  return category ? { category, invocation: `deno task ${taskName}` } : null
}

function classifyPmRunTarget(
  pm: string,
  target: string,
  rest: string[],
  depth: number
): MatchedDiskHeavyCommand | null {
  if (isHelpOrVersionQuery(rest, false)) return null
  const nodeModTool = nodeModulesBinaryName(target)
  if (nodeModTool) return classifyCommandTokens([nodeModTool, ...rest], depth + 1)

  const scriptCategory = classifyScriptName(target, { allowBareCheck: true })
  if (scriptCategory) return { category: scriptCategory, invocation: `${pm} ${target}` }

  const toolCategory =
    classifyOrchestrator(basename(target).toLowerCase(), rest) ??
    classifyDirectTool(basename(target).toLowerCase(), rest)
  return toolCategory ? { category: toolCategory, invocation: `${pm} ${target}` } : null
}

function isPmRunSubcommand(pm: "pnpm" | "npm" | "yarn" | "bun", subLower: string): boolean {
  return (
    subLower === "run" ||
    subLower === "run-script" ||
    (pm === "npm" && (subLower === "rum" || subLower === "urn"))
  )
}

function isPmExecSubcommand(pm: "pnpm" | "npm" | "yarn" | "bun", subLower: string): boolean {
  return (
    subLower === "exec" ||
    subLower === "dlx" ||
    ((pm === "bun" || pm === "npm") && subLower === "x")
  )
}

function classifyPmSubcommand(
  pm: "pnpm" | "npm" | "yarn" | "bun",
  args: string[],
  depth: number
): MatchedDiskHeavyCommand | null {
  if (isHelpOrVersionQuery(args, true)) return null
  const idx = skipOptions(args, 0, PM_VALUE_FLAGS[pm])
  const sub = args[idx]
  if (!sub) return null
  const subLower = sub.toLowerCase()
  const afterSub = args.slice(idx + 1)

  if (pm === "bun" && subLower === "build") {
    return isHelpOrVersionQuery(afterSub, false)
      ? null
      : { category: "build", invocation: "bun build" }
  }
  if (isPmRunSubcommand(pm, subLower)) {
    const scriptIdx = skipOptions(afterSub, 0, PM_VALUE_FLAGS[pm])
    const script = afterSub[scriptIdx]
    return script ? classifyPmRunTarget(pm, script, afterSub.slice(scriptIdx + 1), depth) : null
  }
  if (isPmExecSubcommand(pm, subLower)) {
    return classifyRunnerTokens(afterSub, PM_VALUE_FLAGS[pm]!, depth)
  }
  if (pm === "npm") return null
  return classifyPmRunTarget(pm, sub, afterSub, depth)
}

type SpecialCommandClassifier = (args: string[], depth: number) => MatchedDiskHeavyCommand | null

const SPECIAL_COMMAND_CLASSIFIERS: Readonly<Record<string, SpecialCommandClassifier>> = {
  eval: (args, depth) => findDiskHeavyCommand(args.join(" "), depth + 1),
  pnpm: (args, depth) => classifyPmSubcommand("pnpm", args, depth),
  npm: (args, depth) => classifyPmSubcommand("npm", args, depth),
  bun: (args, depth) => classifyPmSubcommand("bun", args, depth),
  yarn: (args, depth) => classifyYarnTokens(args, depth),
  npx: (args, depth) => classifyRunnerTokens(args, PM_VALUE_FLAGS.npx!, depth),
  pnpx: (args, depth) => classifyRunnerTokens(args, PM_VALUE_FLAGS.pnpx!, depth),
  bunx: (args, depth) => classifyRunnerTokens(args, PM_VALUE_FLAGS.bunx!, depth),
  node: (args, depth) => classifyNodeTokens(args, depth),
  deno: (args) => classifyDenoTokens(args),
}

function classifyDirectOrOrchestrator(
  cmd: string,
  remaining: string[]
): MatchedDiskHeavyCommand | null {
  const args = remaining.slice(1)
  const orchestrator = classifyOrchestrator(cmd, args)
  if (orchestrator) return { category: orchestrator, invocation: remaining.slice(0, 3).join(" ") }
  const direct = classifyDirectTool(cmd, args)
  return direct ? { category: direct, invocation: remaining.slice(0, 2).join(" ") } : null
}

function classifyCommandTokens(tokens: string[], depth: number): MatchedDiskHeavyCommand | null {
  if (depth > MAX_RECURSION_DEPTH || tokens.length === 0) return null

  const unwrapped = unwrapLeadingPrefixes(tokens)
  if (!unwrapped) return null
  if (unwrapped.nestedBody !== undefined) {
    return findDiskHeavyCommand(unwrapped.nestedBody, depth + 1)
  }

  const remaining = unwrapped.remaining
  if (remaining.length === 0) return null

  const cmd = basename(remaining[0]!).toLowerCase()
  if (SHELL_EXECUTABLES.has(cmd)) {
    const body = shellCommandFlagBody(remaining, 1)
    return body ? findDiskHeavyCommand(body, depth + 1) : null
  }
  const special = SPECIAL_COMMAND_CLASSIFIERS[cmd]
  if (special) return special(remaining.slice(1), depth)

  return classifyDirectOrOrchestrator(cmd, remaining)
}

function heredocFeedsShell(header: string): boolean {
  return splitShellSegments(header).some((segment) => {
    const tokens = stripOuterGrouping(
      stripRedirections(tokenizeShellSegment(normalizeCommand(segment)))
    )
    const unwrapped = unwrapLeadingPrefixes(tokens)
    const first = unwrapped?.remaining[0]
    return first !== undefined && SHELL_EXECUTABLES.has(basename(first).toLowerCase())
  })
}

function inspectHeredoc(heredoc: ShellHeredoc, depth: number): MatchedDiskHeavyCommand | null {
  if (heredocFeedsShell(heredoc.header)) {
    return findDiskHeavyCommand(heredoc.body, depth + 1)
  }
  if (heredoc.quoted) return null
  for (const match of heredoc.body.matchAll(HEREDOC_SUBCOMMAND_RE)) {
    const body = match[1] ?? match[2] ?? ""
    if (!body.trim()) continue
    const hit = findDiskHeavyCommand(body, depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * Inspect a shell command string and return the first matched dev/build/typecheck/lint
 * invocation (including common equivalents and wrapper/subshell forms), or null.
 */
export function findDiskHeavyCommand(command: string, depth = 0): MatchedDiskHeavyCommand | null {
  if (depth > MAX_RECURSION_DEPTH || !command.trim()) return null

  const parsed = splitHeredocBodies(command)
  for (const heredoc of parsed.heredocs) {
    const hit = inspectHeredoc(heredoc, depth)
    if (hit) return hit
  }

  const normalized = normalizeCommand(parsed.command).normalize("NFKC")
  for (const sub of extractExecutableSubcommands(normalized)) {
    const hit = findDiskHeavyCommand(sub, depth + 1)
    if (hit) return hit
  }

  for (const segment of splitShellSegments(normalized)) {
    const collapsed = segment.replace(PATH_PREFIX_SUB_RE, "/sub")
    const tokens = stripOuterGrouping(stripRedirections(tokenizeShellSegment(collapsed)))
    const hit = classifyCommandTokens(tokens, depth)
    if (hit) return hit
  }
  return null
}

/** Read available bytes on the filesystem containing `dir` (falls back to cwd and `/`). */
export async function getFreeDiskBytes(dir: string): Promise<number | null> {
  for (const target of [dir, process.cwd(), "/"]) {
    if (!target) continue
    try {
      const stats = await statfs(target)
      const available = Number(stats.bavail) * Number(stats.bsize)
      if (Number.isFinite(available) && available >= 0) return available
    } catch {
      // Path may not exist yet; try next candidate.
    }
  }
  return null
}

function formatFreeSpace(bytes: number): string {
  const mib = Math.floor(bytes / (1024 * 1024))
  return `${mib} MiB (${(bytes / MIN_FREE_DISK_BYTES).toFixed(2)} GiB)`
}

function buildDenyMessage(match: MatchedDiskHeavyCommand, freeBytes: number): string {
  return [
    `**Low disk space: \`${match.invocation}\` (${match.category}) blocked.**`,
    `Available free disk space is ${formatFreeSpace(freeBytes)}, which is below the 1 GiB (1024 MiB) minimum required to run dev, build, typecheck, or lint commands safely.`,
    "Do not try to work around this check with an alternative package manager, task runner, or direct binary (e.g. `npm`, `yarn`, `bun`, `npx`, `turbo`, `nx`, `tsc`, `eslint`, `biome`, `next`, `vite`).",
    formatActionPlan([
      "Check available disk space (`df -h`) and identify large caches or build outputs.",
      "Reclaim at least 1 GiB of free space (e.g. remove `.next`/`dist`/`.turbo`, run `pnpm store prune` or `bun pm cache rm`, or ask the user to free disk space).",
      `Re-run \`${match.invocation}\` once at least 1 GiB is free.`,
    ]),
  ].join("\n\n")
}

/** Evaluate the low-disk-space PreToolUse gate with an injectable disk-space reader. */
export async function evaluateLowDiskSpace(
  input: ShellHookInput,
  readFreeBytes: FreeDiskBytesReader = getFreeDiskBytes
): Promise<SwizHookOutput> {
  if (!isShellTool(input.tool_name ?? "")) return {}

  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : ""
  const match = findDiskHeavyCommand(command)
  if (!match) return {}

  const { cwd } = resolveShellCwd(input)
  const freeBytes = await readFreeBytes(cwd)
  if (freeBytes === null || freeBytes >= MIN_FREE_DISK_BYTES) return {}

  return preToolUseDeny(buildDenyMessage(match, freeBytes))
}

const pretooluseLowDiskSpace: SwizShellHook = {
  name: "pretooluse-low-disk-space",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  async run(input) {
    return await evaluateLowDiskSpace(input as ShellHookInput)
  },
}

export default pretooluseLowDiskSpace

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseLowDiskSpace)

import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import ts from "typescript"
import { listChangedFiles } from "./changed-files.ts"

export interface TypecheckOptions {
  failFast?: boolean
  incremental?: boolean
  changedFiles?: string[]
  tsBuildInfoFile?: string
}

export interface TypecheckResult {
  diagnostics: readonly ts.Diagnostic[]
  stoppedEarly: boolean
  checkedFiles: number
}

const DEFAULT_BUILD_INFO_REL = join(".cache", "tsconfig.tsbuildinfo")

function parseProjectConfig(root: string): ts.ParsedCommandLine {
  const configPath = join(root, "tsconfig.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n")
    )
  }
  return parsed
}

function orderSourceFiles(
  program: ts.EmitAndSemanticDiagnosticsBuilderProgram,
  changedFiles: readonly string[],
  skipLibCheck: boolean
): ts.SourceFile[] {
  const prioritySet = new Set(changedFiles.map((filePath) => resolve(filePath)))
  const prioritized: ts.SourceFile[] = []
  const remaining: ts.SourceFile[] = []
  for (const sf of program.getSourceFiles()) {
    if (skipLibCheck && sf.isDeclarationFile) continue
    const normalized = resolve(sf.fileName)
    if (prioritySet.has(normalized)) {
      prioritized.push(sf)
    } else {
      remaining.push(sf)
    }
  }
  return [...prioritized, ...remaining]
}

function collectFileDiagnostics(
  program: ts.EmitAndSemanticDiagnosticsBuilderProgram,
  sf: ts.SourceFile,
  failFast: boolean
): ts.Diagnostic[] {
  const syntactic = program.getSyntacticDiagnostics(sf)
  if (failFast && syntactic.length > 0) return [...syntactic]
  const semantic = program.getSemanticDiagnostics(sf)
  return [...syntactic, ...semantic]
}

function collectOrderedDiagnostics(
  program: ts.EmitAndSemanticDiagnosticsBuilderProgram,
  orderedFiles: readonly ts.SourceFile[],
  initialDiagnostics: ts.Diagnostic[],
  failFast: boolean
): TypecheckResult {
  const diagnostics = [...initialDiagnostics]
  let checkedFiles = 0
  for (const sf of orderedFiles) {
    checkedFiles++
    const fileDiagnostics = collectFileDiagnostics(program, sf, failFast)
    if (fileDiagnostics.length === 0) continue
    diagnostics.push(...fileDiagnostics)
    if (failFast) {
      return { diagnostics, stoppedEarly: true, checkedFiles }
    }
  }
  return { diagnostics, stoppedEarly: false, checkedFiles }
}

async function createTypecheckProgram(
  root: string,
  incremental: boolean,
  tsBuildInfoFile: string
): Promise<{
  program: ts.EmitAndSemanticDiagnosticsBuilderProgram
  skipLibCheck: boolean
}> {
  const parsed = parseProjectConfig(root)
  const compilerOptions: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    ...(incremental ? { incremental: true, tsBuildInfoFile } : { incremental: false }),
  }
  if (incremental) await mkdir(dirname(tsBuildInfoFile), { recursive: true })
  const program = ts.createIncrementalProgram({
    rootNames: parsed.fileNames,
    options: compilerOptions,
  })
  return { program, skipLibCheck: Boolean(compilerOptions.skipLibCheck) }
}

/**
 * Run TypeScript typechecking with incremental `.tsbuildinfo` caching and optional fail-fast
 * ordering (changed files checked first, stopping after the first failing file).
 */
export async function runTypecheck(
  root: string,
  opts: TypecheckOptions = {}
): Promise<TypecheckResult> {
  const {
    failFast = true,
    incremental = true,
    tsBuildInfoFile = join(root, DEFAULT_BUILD_INFO_REL),
    changedFiles = listChangedFiles(root),
  } = opts
  const { program, skipLibCheck } = await createTypecheckProgram(root, incremental, tsBuildInfoFile)
  const globalDiagnostics: ts.Diagnostic[] = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ]
  if (failFast && globalDiagnostics.length > 0) {
    return { diagnostics: globalDiagnostics, stoppedEarly: true, checkedFiles: 0 }
  }

  const orderedFiles = orderSourceFiles(program, changedFiles, skipLibCheck)
  const result = collectOrderedDiagnostics(program, orderedFiles, globalDiagnostics, failFast)
  if (result.diagnostics.length === 0 && incremental) program.emit()
  return result
}

function formatDiagnosticsOutput(root: string, diagnostics: readonly ts.Diagnostic[]): string {
  const formatHost: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => ts.sys.newLine,
  }
  return process.stdout.isTTY
    ? ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost)
    : ts.formatDiagnostics(diagnostics, formatHost)
}

function parseCliArgs(args: string[]): {
  passthrough: boolean
  failFast: boolean
  incremental: boolean
} {
  let failFast = true
  let incremental = true
  for (const arg of args) {
    if (arg === "--all" || arg === "--no-fail-fast") {
      failFast = false
    } else if (arg === "--no-incremental") {
      incremental = false
    } else {
      return { passthrough: true, failFast, incremental }
    }
  }
  return { passthrough: false, failFast, incremental }
}

async function runPassthroughTsc(root: string, args: string[]): Promise<number> {
  const proc = Bun.spawn(
    [process.execPath, join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", ...args],
    {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  )
  return await proc.exited
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..")
  const args = process.argv.slice(2)
  const cli = parseCliArgs(args)
  if (cli.passthrough) {
    process.exitCode = await runPassthroughTsc(root, args)
    return
  }

  const result = await runTypecheck(root, {
    failFast: cli.failFast,
    incremental: cli.incremental,
  })
  if (result.diagnostics.length > 0) {
    process.stderr.write(formatDiagnosticsOutput(root, result.diagnostics))
    if (result.stoppedEarly) {
      process.stderr.write(
        "Stopped after first failing file (fail-fast). Run `bun run typecheck -- --all` for all errors.\n"
      )
    }
    process.exitCode = 1
  }
}

if (import.meta.main) {
  void main().catch((error: Error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

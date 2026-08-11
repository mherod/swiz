#!/usr/bin/env bun

const CLI_PROCESS_STARTED_AT = performance.now()

// Guard: require invocation via the globally linked `swiz` command.
// The shell sets process.env._ to the command that was actually executed.
// When run via `swiz`, it ends with "/swiz"; when run via `bun index.ts`, it points to bun.
// Only enforce in interactive terminals — subprocess/test invocations (piped stdio) are allowed.

const invokedAs = process.env._ ?? ""
// noinspection PointlessBooleanExpressionJS
const isInteractive = process.stderr.isTTY === true
if (isInteractive && !invokedAs.endsWith("/swiz") && !process.env.SWIZ_DIRECT) {
  process.stderr.write(
    "Error: swiz must be invoked via the globally linked command.\n" +
      "\n" +
      "  Run: swiz <command>\n" +
      "\n" +
      "If you haven't linked yet, run: bun link\n" +
      "To bypass this check: SWIZ_DIRECT=1 bun index.ts <command>\n"
  )
  process.exit(1)
}

// Signal listeners for tidy exit and cleanup.
const handleSignal = async (signal: string) => {
  // Use stderr to avoid polluting stdout if the output is being piped.
  process.stderr.write(`\nReceived ${signal}. Cleaning up...\n`)

  // Give process.on("exit") handlers a moment to run by exiting,
  // but if we exit abruptly async cleanup won't happen.
  // Actually, process.exit() runs process.on('exit') handlers synchronously.

  // Standard exit codes: 128 + signal number
  // SIGINT (2) -> 130, SIGTERM (15) -> 143, SIGHUP (1) -> 129, SIGQUIT (3) -> 131
  const exitCodes: Record<string, number> = {
    SIGINT: 130,
    SIGTERM: 143,
    SIGHUP: 129,
    SIGQUIT: 131,
  }

  process.exitCode = exitCodes[signal] ?? 1
  process.exit()
}

process.on("SIGINT", () => void handleSignal("SIGINT"))
process.on("SIGTERM", () => void handleSignal("SIGTERM"))
process.on("SIGHUP", () => void handleSignal("SIGHUP"))
process.on("SIGQUIT", () => void handleSignal("SIGQUIT"))

// Global timeout: ensure the CLI terminates if it exceeds a requested budget.
// Useful for CI environments or automated runs where a hang is unacceptable.
const timeoutSeconds = parseInt(process.env.SWIZ_TIMEOUT ?? "0", 10)
if (timeoutSeconds > 0) {
  setTimeout(() => {
    process.stderr.write(`\nGlobal timeout reached (${timeoutSeconds}s). Exiting...\n`)
    process.exit(1)
  }, timeoutSeconds * 1000).unref()
}

function shouldUseThinDispatch(argv: string[]): boolean {
  if (argv[0] !== "dispatch" || process.env.SWIZ_TEST_FORCE_DISPATCH_FAILURE === "1") return false
  const args = argv.slice(1)
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--agent" && index + 1 < args.length) index++
    else positional.push(args[index]!)
  }
  const event = positional[0]
  return !!event && event !== "replay" && event !== "stop" && event !== "subagentStop"
}

async function runGeneralCli(): Promise<void> {
  const [
    cli,
    skill,
    hooks,
    install,
    uninstall,
    status,
    statusLine,
    settings,
    state,
    tasks,
    shim,
    dispatch,
    transcript,
    continueModule,
    issue,
    stash,
    crossRepoIssue,
    idea,
    reflect,
    sentiment,
    session,
    ciWait,
    memory,
    model,
    plugins,
    manage,
    mcp,
    compact,
    mergetool,
    pushWait,
    pushCi,
    doctor,
    emergencyBypass,
    usage,
    daemon,
  ] = await Promise.all([
    import("./src/cli.ts"),
    import("./src/commands/skill.ts"),
    import("./src/commands/hooks.ts"),
    import("./src/commands/install.ts"),
    import("./src/commands/uninstall.ts"),
    import("./src/commands/status.ts"),
    import("./src/commands/status-line.ts"),
    import("./src/commands/settings.ts"),
    import("./src/commands/state.ts"),
    import("./src/commands/tasks.ts"),
    import("./src/commands/shim.ts"),
    import("./src/commands/dispatch.ts"),
    import("./src/commands/transcript.ts"),
    import("./src/commands/continue.ts"),
    import("./src/commands/issue.ts"),
    import("./src/commands/stash.ts"),
    import("./src/commands/cross-repo-issue.ts"),
    import("./src/commands/idea.ts"),
    import("./src/commands/reflect.ts"),
    import("./src/commands/sentiment.ts"),
    import("./src/commands/session.ts"),
    import("./src/commands/ci-wait.ts"),
    import("./src/commands/memory.ts"),
    import("./src/commands/model.ts"),
    import("./src/commands/plugins.ts"),
    import("./src/commands/manage.ts"),
    import("./src/commands/mcp.ts"),
    import("./src/commands/compact.ts"),
    import("./src/commands/mergetool.ts"),
    import("./src/commands/push-wait.ts"),
    import("./src/commands/push-ci.ts"),
    import("./src/commands/doctor.ts"),
    import("./src/commands/emergency-bypass.ts"),
    import("./src/commands/usage.ts"),
    import("./src/commands/daemon.ts"),
  ])

  const commands = [
    skill.skillCommand,
    hooks.hooksCommand,
    install.installCommand,
    uninstall.uninstallCommand,
    status.statusCommand,
    statusLine.statusLineCommand,
    settings.settingsCommand,
    state.stateCommand,
    tasks.tasksCommand,
    shim.shimCommand,
    dispatch.dispatchCommand,
    transcript.transcriptCommand,
    continueModule.continueCommand,
    issue.issueCommand,
    stash.stashCommand,
    crossRepoIssue.crossRepoIssueCommand,
    idea.ideaCommand,
    reflect.reflectCommand,
    sentiment.sentimentCommand,
    session.sessionCommand,
    ciWait.ciWaitCommand,
    memory.memoryCommand,
    model.modelCommand,
    plugins.pluginsCommand,
    manage.manageCommand,
    mcp.mcpCommand,
    compact.compactCommand,
    mergetool.mergetoolCommand,
    pushWait.pushWaitCommand,
    pushCi.pushCiCommand,
    doctor.doctorCommand,
    emergencyBypass.emergencyBypassCommand,
    usage.usageCommand,
    daemon.daemonCommand,
  ]
  for (const command of commands) cli.registerCommand(command)
  await cli.run()
}

const cliArgs = process.argv.slice(2)
if (shouldUseThinDispatch(cliArgs)) {
  const { runThinDispatch } = await import("./src/commands/dispatch-bootstrap.ts")
  await runThinDispatch(process.argv.slice(3), CLI_PROCESS_STARTED_AT)
} else {
  await runGeneralCli()
}

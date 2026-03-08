import AppKit

// Prevent dock icon — this also gives the process a bundle context so
// UNUserNotificationCenter can deliver notifications from a CLI tool.
NSApplication.shared.setActivationPolicy(.prohibited)

let cliArgs = Array(CommandLine.arguments.dropFirst())

if cliArgs.isEmpty || cliArgs.contains("--help") || cliArgs.contains("-h") {
    let usageText = """
    swiz-notify — send rich native macOS notifications

    USAGE
      swiz-notify --title <title> [options]

    OPTIONS
      --title     <text>           Notification title (required)
      --subtitle  <text>           Secondary headline beneath title
      --body      <text>           Main message body
      --sound     <name|default|none>  Audio feedback (default: "default")
      --identifier <id>            Unique notification ID (default: UUID)
      --category  <id>             Category identifier for action buttons
      --image     <path>           Absolute path to an image attachment
      --timeout   <seconds>        Max wait time for user action (default: 10)
      --action    <id> <title>     Add an action button (repeatable)

    EXAMPLES
      swiz-notify --title "Build complete" --body "All tests passed" --sound Hero

      swiz-notify --title "Review needed" --body "PR #42 is awaiting review" \\
        --action open "Open PR" --action dismiss "Dismiss"

    OUTPUT
      If action buttons are provided, the chosen action identifier is printed to stdout.
    """
    fputs("\(usageText)\n", stdout)
    exit(0)
}

let args: NotifyArgs
do {
    args = try parseArgs(cliArgs)
} catch {
    fputs("swiz-notify: \(error)\n", stderr)
    exit(ExitCode.badArgs.rawValue)
}

let exitCode = await Notifier.shared.deliver(args: args)
exit(exitCode.rawValue)

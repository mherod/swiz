# Verify browser CLI enforcement

Swiz blocks `playwright-cli` and `playwriter` commands, including supported package runners and shell wrappers. Use the available browser automation tools for browser work.

Verify these states independently:

1. Policy tests pass on the current source.
2. The intended agent has hook registrations and can resolve the `swiz` executable.
3. The installed dispatcher returns a denial for the original tool payload.
4. The running host intercepts a harmless banned-command probe and permits a benign control.

`swiz doctor` reports registration checks and recent dispatch evidence separately. Its evidence rows never claim that the host honored a returned decision. Automatic self-repair being paused does not disable installed hooks.

## Inspect a session

```sh
swiz enforcement --session <session-id> --since-minutes 20
swiz enforcement --session <session-id> --json
```

Reports are scoped to the current project. Captures are joined with hook logs by session and dispatch ID. A matching denial is `denied`; successful hooks plus a completed dispatch are `passed`; missing correlation, timeouts and incomplete execution are `unknown`. None of these alone proves that a client honored the result.

Capture retention defaults to ten minutes. Reports disclose retention and scan limits. Missing/expired captures mean no event was observed in the available evidence, not that a session was inactive or a command was allowed. Evidence older than five minutes is labeled stale; an idle client is not necessarily broken.

## Check the resolved-command boundary

In a host shell tool, `false && playwriter skill` cannot launch Playwriter. The expected result is a browser-ban denial, rather than just the shell's exit code. A benign control such as `echo playwriter` should succeed.

For Codex code mode, construct the same harmless command with variables or a template and pass it to `tools.exec_command`. Verify that a corresponding resolved shell payload reaches Swiz and is denied. The verified desktop host emits `Bash` with `tool_input.command`; native `exec_command` with `tool_input.cmd` is also supported.

The outer `exec`/`functions.exec` parser checks literal commands only. It cannot establish protection for computed JavaScript when the host does not dispatch a resolved shell event. Do not evaluate untrusted code to discover its command or infer universal protection from another host's probe.

## Export and replay an incident

```sh
swiz enforcement export --file <capture.json>
swiz enforcement replay --file <capture-or-export.json>
```

Both commands print JSON. Export keeps only the tool name and command/code fields, removes session/environment/transcript/output data, and redacts recognizable credentials. Review command content for private data before sharing: heuristic redaction cannot identify every secret. Redaction can alter policy behavior, so exported fixtures are not exact wire evidence.

Replay invokes only the browser CLI policy predicate. It never executes the captured command or JavaScript, and it does not run other hooks. `deny` identifies a ban match; `no-match` is not permission from other policies; `unresolved` means no supported literal/resolved command was available. A mixed code block may contain both inspectable literals and computed commands; literal coverage does not imply full coverage.

## Recover one agent

```sh
swiz install --codex --hooks-only
swiz install --uninstall --codex --hooks-only
```

Replace `--codex` with the intended agent flag. Hook-only recovery preserves MCP, shared shell profiles and project settings. A scoped install without `--hooks-only` also manages that agent's MCP registration, while shared shell/project changes remain part of an unscoped install.

Explicit installation enables self-repair only for the selected agents; explicit removal pauses it for those agents. Per-agent state overrides the legacy global pause marker without removing it or reviving another agent. Settings and state writes retain backups. Session-start recovery identifies the originating agent, checks its own registrations, and uses hook-only installation; unknown or plugin-owned callers do not trigger broad installation. Reload/trust the configuration as required by the host, then repeat live probes.

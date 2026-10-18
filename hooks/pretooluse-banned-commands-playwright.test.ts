import { describe, expect, test } from "bun:test"
import { groupMatches } from "../src/dispatch/engine.ts"
import { bundledHookManifest, hookIdentifier } from "../src/manifest.ts"
import { runBashHook } from "../src/utils/test-utils.ts"
import { evaluatePretooluseBannedCommands } from "./pretooluse-banned-commands.ts"

const HOOK = "hooks/pretooluse-banned-commands.ts"

describe("playwright-cli ban", () => {
  test.each([
    "playwright-cli",
    "playwright-cli open https://example.com",
    "npx playwright-cli snapshot",
    "npx --yes playwright-cli@latest snapshot",
    "bunx playwright-cli snapshot",
    "bun x playwright-cli snapshot",
    "pnpm exec playwright-cli snapshot",
    "pnpm dlx playwright-cli snapshot",
    "npm exec -- playwright-cli snapshot",
    "yarn dlx playwright-cli snapshot",
    "./node_modules/.bin/playwright-cli snapshot",
    "CI=1 playwright-cli snapshot",
    "command playwright-cli snapshot",
    "echo ready && playwright-cli snapshot",
    "echo ready;playwright-cli",
    '"playwright-cli" snapshot',
    "'playwright-cli' snapshot",
    'playwright-"cli" snapshot',
    '"/opt/my tools/playwright-cli" snapshot',
    "echo ready\nplaywright-cli snapshot",
    'echo "ready\nstill ready"\n"playwright-cli" snapshot',
    'env CI=1 command -- "playwright-cli" snapshot',
    'CI=1 command env MODE="two words" bunx "playwright-cli@latest" snapshot',
    "env -u DISPLAY -- CI=1 playwright-cli snapshot",
    "exec -a browser env CI=1 playwright-cli snapshot",
    "npx --package playwright-cli -- playwright-cli snapshot",
    "npx --offline --yes --package @playwright/mcp playwright-cli --help",
    "npm exec --package @playwright/mcp -- playwright-cli snapshot",
    'sh -c "npx --offline --yes --package @playwright/mcp playwright-cli --help"',
    "npx --package @playwright/mcp -c 'playwright-cli snapshot'",
    'echo "$(playwright-cli snapshot)"',
    "npx --offline \\\n--yes --package @playwright/mcp playwright-cli --help",
  ])("blocks %s", async (command) => {
    const result = await runBashHook(HOOK, command)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("Do not use `playwright-cli`")
  })

  test.each([
    "bunx playwright test",
    "playwright --version",
    "playwright-cli-helper --help",
    "echo playwright-cli",
    'echo "playwright-cli snapshot"',
    "rg 'playwright-cli' hooks",
    "cat docs/playwright-cli.md",
    'echo "ready\nplaywright-cli snapshot"',
    "command -v playwright-cli",
    "env LABEL=playwright-cli echo ready",
    "env -u playwright-cli echo ready",
    "npx --package playwright-cli echo ready",
    "bunx another-tool playwright-cli",
  ])("allows %s", async (command) => {
    const result = await runBashHook(HOOK, command)
    expect(result.decision).not.toBe("deny")
  })
})

describe("Playwriter fallback ban", () => {
  test.each([
    "playwriter skill",
    "npx --yes playwriter@latest skill",
    "npx --offline --yes playwriter@latest session new --direct 127.0.0.1:9238",
    "npx --offline --yes playwriter@latest -s 2 --timeout 20000 -e 'await state.page.screenshot()'",
    "bunx playwriter@latest session new",
    "bun x playwriter session new",
    "npm exec --package playwriter -- playwriter skill",
    "pnpm dlx playwriter@latest skill",
    "yarn dlx playwriter@latest skill",
    "./node_modules/.bin/playwriter skill",
    'CI=1 command env MODE="two words" bunx "playwriter@latest" skill',
    'env -u DISPLAY /bin/zsh -lc "npx --offline --yes playwriter@latest skill"',
    'npm exec --package playwriter --call="playwriter skill"',
  ])("blocks %s", async (command) => {
    const result = await runBashHook(HOOK, command)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("playwriter")
    expect(result.reason).toContain("available browser automation tools")
  })

  test.each([
    "echo playwriter",
    'echo "npx playwriter@latest skill"',
    "rg 'playwriter' hooks",
    "command -v playwriter",
    "playwriter-helper --help",
    "env LABEL=playwriter echo ready",
    "npx --package playwriter echo ready",
    "bunx another-tool playwriter",
    'sh -c "echo playwriter"',
    'npx --package playwriter -c "echo playwriter"',
    "echo '$(playwriter skill)'",
    "bunx playwright test",
  ])("allows %s", async (command) => {
    expect((await runBashHook(HOOK, command)).decision).not.toBe("deny")
  })
})

describe("Codex browser CLI enforcement", () => {
  const command = "npx --offline --yes --package @playwright/mcp playwright-cli --help"

  test.each(["exec_command", "functions.exec_command"])("checks %s cmd input", async (toolName) => {
    const result = await evaluatePretooluseBannedCommands({
      tool_name: toolName,
      tool_input: { cmd: command },
      cwd: process.cwd(),
    })
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
  })

  test.each(["exec", "functions.exec"])("routes and checks %s shell calls", async (toolName) => {
    const groups = bundledHookManifest.filter(
      (group) => group.event === "preToolUse" && groupMatches(group, toolName, undefined)
    )
    expect(groups.flatMap((group) => group.hooks.map(hookIdentifier))).toContain(
      "pretooluse-banned-commands.ts"
    )
    for (const code of [
      `text(await tools.exec_command({cmd:${JSON.stringify(command)}}));`,
      'await tools.exec_command({cmd:"echo ready"}); await tools.exec_command({cmd:"bunx playwriter@latest skill"});',
    ]) {
      const result = await evaluatePretooluseBannedCommands({
        tool_name: toolName,
        tool_input: { code },
        cwd: process.cwd(),
      })
      expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    }
  })

  test("checks the exec input field", async () => {
    const result = await evaluatePretooluseBannedCommands({
      tool_name: "exec",
      tool_input: { input: `await tools.exec_command({cmd:${JSON.stringify(command)}})` },
    })
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
  })

  test.each([
    'text("playwright-cli");',
    'await tools.exec_command({cmd:"rg playwright-cli hooks"});',
    'await tools.exec_command({cmd:"bunx playwright test"});',
  ])("allows unrelated exec code: %s", async (code) => {
    const result = await evaluatePretooluseBannedCommands({
      tool_name: "exec",
      tool_input: { code },
    })
    expect(result).toEqual({})
  })
})

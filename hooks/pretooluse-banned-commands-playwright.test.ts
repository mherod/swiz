import { describe, expect, test } from "bun:test"
import { runBashHook } from "../src/utils/test-utils.ts"

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

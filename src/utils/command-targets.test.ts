import { expect, test } from "bun:test"
import { parseLintCommand } from "../../hooks/pretooluse-measure-lint-time.ts"
import { parseTestCommand } from "../../hooks/pretooluse-measure-test-time.ts"
import { collectTargets } from "./command-targets.ts"

test.each([
  ["eslint --format json src/", ["src/"]],
  ["eslint --format=json src/", ["src/"]],
  ["eslint -- --format", ["--format"]],
  ["eslint src/ > lint.log", ["src/"]],
  ["NODE_ENV=test biome check .", ["."]],
])("lint targets: %s", (command, targets) => {
  expect(parseLintCommand(command)).toEqual({ isLint: true, targets })
})

test.each([
  ["bun test --reporter dots src/", ["src/"]],
  ["bun test --reporter=dots src/", ["src/"]],
  ["bun test -- --timeout", ["--timeout"]],
  ["bun test src/ > test.log", ["src/"]],
  ["NODE_ENV=test vitest run --config test.config.ts .", ["."]],
])("test targets: %s", (command, targets) => {
  expect(parseTestCommand(command)).toEqual({ isTest: true, targets })
})

test.each(["&&", "||", ";", "|", "&"])("stops collecting at %s", (operator) => {
  expect(collectTargets(["test", "src/", operator, "echo", "next"], 1, new Set())).toEqual(["src/"])
})

test("a flag only consumes a separate value when its runner declares it", () => {
  const tokens = ["runner", "--custom", "value", "src/"]
  expect(collectTargets(tokens, 1, new Set(["--custom"]))).toEqual(["src/"])
  expect(collectTargets(tokens, 1, new Set())).toEqual(["value", "src/"])
})

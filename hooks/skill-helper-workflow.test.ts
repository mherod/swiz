import { beforeAll, describe, expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { join, relative } from "node:path"
import { normalizeAgentHookPayload } from "../src/dispatch/payload-normalize.ts"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import { neutralAgentEnvOverrides, runHookInProcess, useTempDir } from "../src/utils/test-utils.ts"

const HOOKS = [
  "hooks/pretooluse-no-npm.ts",
  "hooks/pretooluse-banned-commands.ts",
  "hooks/pretooluse-protect-sandbox.ts",
]

describe("signed skill helper guard composition (#909)", () => {
  const temp = useTempDir("swiz-helper-policy-")
  let home: string
  let project: string
  let skillRoot: string
  let helper: string

  beforeAll(async () => {
    home = await temp.create()
    project = join(home, "project")
    skillRoot = join(home, ".agents", "skills")
    helper = join(skillRoot, "commit", "scripts", "check-gpg-signing.mjs")
    await mkdir(project, { recursive: true })
    await Bun.write(join(project, "package.json"), '{"packageManager":"pnpm@11.9.0"}')
    await Bun.write(helper, "export const signingPreflight = () => true\n")
    await Bun.write(join(skillRoot, "commit", "scripts", "helper with spaces.mjs"), "")
    await Bun.write(join(home, ".cursor", "skills", "commit", "scripts", "check.mjs"), "")
    await Bun.write(join(home, ".private", "injected.mjs"), "")
    await symlink(join(home, ".private", "injected.mjs"), join(skillRoot, "escape.mjs"))
  })

  async function evaluate(command: string, workdir = project, commandField = "cmd") {
    const payload = {
      tool_name: "functions.exec_command",
      cwd: project,
      tool_input: { [commandField]: command, workdir },
    }
    normalizeAgentHookPayload(payload)
    const outputs: Awaited<ReturnType<typeof runHookInProcess>>[] = []
    // No Git subprocess may run, even if a guard grows a new repository query.
    await withGitClient(new MockGitClient(), async () => {
      for (const hook of HOOKS) {
        outputs.push(
          await runHookInProcess(hook, payload, {
            cwd: project,
            env: neutralAgentEnvOverrides({ HOME: home, AI_TEST_NO_BACKEND: "1" }),
          })
        )
      }
    })
    return outputs
  }

  test("normalizes the actual Codex command while preserving explicit workdir", () => {
    const payload: Record<string, any> = {
      tool_name: "exec_command",
      cwd: "/session",
      tool_input: { cmd: "git status", workdir: "/command" },
    }
    normalizeAgentHookPayload(payload)
    expect(payload.tool_input).toEqual({
      cmd: "git status",
      command: "git status",
      workdir: "/command",
    })
    expect(payload.cwd).toBe("/session")
  })

  test("accepts absolute and relative direct helpers under both shared and provider roots", async () => {
    for (const [command, cwd] of [
      [`bun ${helper} preflight`, project],
      ["bun ./commit/scripts/check-gpg-signing.mjs preflight", skillRoot],
      ["bun commit/scripts/check-gpg-signing.mjs preflight", skillRoot],
      ["bun check-gpg-signing.mjs preflight", join(skillRoot, "commit", "scripts")],
      [`bun ${relative(project, helper)} preflight`, project],
      [`bun '${join(skillRoot, "commit", "scripts", "helper with spaces.mjs")}'`, project],
      [`bun ${join(home, ".cursor", "skills", "commit", "scripts", "check.mjs")}`, project],
    ]) {
      const outputs = await evaluate(command!, cwd!)
      expect(outputs.map((output) => output.decision)).not.toContain("deny")
      expect(outputs[0]?.reason).toContain("Bun runtime")
    }
  })

  test("reports effective cwd without making workdir a hidden-home write escape", async () => {
    const outputs = await evaluate("tee ./config.json", join(home, ".private"))
    const sandbox = outputs[2]!
    expect(sandbox.decision).toBe("deny")
    expect(sandbox.reason).toContain(join(home, ".private"))
    expect(sandbox.reason).toContain("tool_input.workdir")
    expect(sandbox.reason).toContain(project)
    expect(sandbox.reason).not.toContain("unless that cwd")
    for (const command of [
      "tee config",
      "bun ./commit/scripts/check-gpg-signing.mjs; tee config",
    ]) {
      expect((await evaluate(command, skillRoot))[2]?.decision, command).toBe("deny")
    }
  })

  test("classifies symbolic helper paths inside the complete memory preflight (#910)", async () => {
    // Exact command fixture from update-memory on 12 September 2026; no external skill dependency.
    const preflight = await Bun.file(join(import.meta.dir, "fixtures/memory-preflight.sh")).text()
    for (const command of [
      'bun "$SKILLS_ROOT/compact-memory/scripts/analyze-claude-md.ts" --resolve-thresholds',
      'bun "${SKILLS_ROOT}/compact-memory/scripts/analyze-claude-md.ts" --resolve-thresholds',
      '(RESOLUTION=$(bun "$SKILLS_ROOT/compact-memory/scripts/analyze-claude-md.ts" "$@"))',
      preflight,
    ]) {
      const outputs = await evaluate(command)
      expect(
        outputs.map((output) => output.decision),
        command
      ).not.toContain("deny")
      expect(outputs[0]?.reason).toContain("Bun runtime")
    }
  })

  test("symbolic paths do not exempt package operations or nested executable substitutions", async () => {
    for (const command of [
      'bun add "$PACKAGE"',
      "(RESULT=$(bun install))",
      'bun "$SKILLS_ROOT/helper.ts"; bun run build',
      'bun "$(bun add dependency)/helper.ts"',
      'bun "${SKILLS_ROOT:-$(bun install)}/helper.ts"',
      'bun "$SKILLS_ROOT/../../.private/injected.mjs"',
      'bun "$SKILLS_ROOT/helpers/*.ts"',
      'bun "$ENTRY"',
    ]) {
      const outputs = await evaluate(command)
      expect(outputs[0]?.decision, command).toBe("deny")
    }
  })

  test("denies unsupported wrappers and imports with a direct Bun recipe", async () => {
    for (const command of [
      `pnpm exec bun ${helper} preflight`,
      `bun -e 'import { signingPreflight } from "${helper}"'`,
    ]) {
      const outputs = await evaluate(command, skillRoot, "command")
      expect(outputs[2]?.decision).toBe("deny")
      expect(outputs[2]?.reason).toContain(
        "bun <configured-skill-root>/commit/scripts/check-gpg-signing.mjs preflight"
      )
      expect(outputs[2]?.reason).toContain("target repository")
    }
  })

  test("keeps helper exceptions bounded", async () => {
    for (const command of [
      `bun --eval ${helper}`,
      `bun --preload=/tmp/injected.mjs ${helper}`,
      `BUN_OPTIONS=--preload=/tmp/injected.mjs bun ${helper}`,
      `export BUN_OPTIONS=--preload=/tmp/injected.mjs; bun ${helper}`,
      `bun ${helper} > ${helper}`,
      `$(printf bun) ${helper}`,
      `bun ${join(skillRoot, "escape.mjs")}`,
      `bun ${skillRoot}/../../.private/injected.mjs`,
    ]) {
      const outputs = await evaluate(command, project, "command")
      expect(outputs[2]?.decision, command).toBe("deny")
    }
  })

  test("uses the actual cmd field when stale canonical command text is also supplied", () => {
    const payload = {
      tool_name: "exec_command",
      cwd: project,
      tool_input: { cmd: "tee ./config", command: "git status", workdir: join(home, ".private") },
    }
    normalizeAgentHookPayload(payload)
    expect(payload.tool_input.command).toBe("tee ./config")
  })

  test("prints an executable canonical isolated-keyring recipe", async () => {
    const keyring = join(home, "public-keyring")
    const outputs = await evaluate(
      `GNUPGHOME=${keyring} git verify-commit --raw abc123`,
      project,
      "command"
    )
    expect(outputs[1]?.decision).toBe("deny")
    expect(outputs[1]?.reason).toContain("export GNUPGHOME=")
    const accepted = await evaluate(`export GNUPGHOME=${keyring}\ngit verify-commit --raw abc123`)
    expect(accepted.map((output) => output.decision)).not.toContain("deny")
    const recipe = outputs[1]!
      .reason!.match(/export GNUPGHOME=.*\n {2}git verify-commit --raw <sha>/)![0]
      .replace("/tmp/<isolated-public-keyring>", keyring)
      .replace("<sha>", "abc123")
    expect((await evaluate(recipe)).map((output) => output.decision)).not.toContain("deny")
    const configured = await evaluate(
      `export GNUPGHOME=${keyring}; git -c gpg.format=openpgp -c gpg.openpgp.program=/opt/homebrew/bin/gpg verify-commit --raw abc123`
    )
    expect(configured.map((output) => output.decision)).not.toContain("deny")
  })

  test("rejects executable/configuration overrides in inline and exported Git environments", async () => {
    for (const variable of [
      "GIT_EXEC_PATH",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      for (const prefix of [`${variable}=untrusted `, `export ${variable}=untrusted; `]) {
        const outputs = await evaluate(
          `${prefix}git verify-commit --raw abc123`,
          project,
          "command"
        )
        expect(outputs[1]?.decision, prefix).toBe("deny")
        expect(outputs[1]?.reason).not.toContain("export GNUPGHOME=")
      }
    }
  })
})

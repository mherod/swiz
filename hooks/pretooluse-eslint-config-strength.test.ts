/**
 * Unit tests for isEslintConfigFile regex and countEnforcements.
 * Tests all supported file formats to prevent regressions on the regex.
 */
import { describe, expect, test } from "bun:test"
import { neutralAgentEnv } from "../src/utils/test-utils.ts"
import { countEnforcements, isEslintConfigFile } from "./pretooluse-eslint-config-strength.ts"

// ═══════════════════════════════════════════════════════════════════════════════
// isEslintConfigFile: Modern flat config formats
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEslintConfigFile: modern flat config", () => {
  test("eslint.config.js", () => {
    expect(isEslintConfigFile("eslint.config.js")).toBe(true)
  })

  test("eslint.config.mjs", () => {
    expect(isEslintConfigFile("eslint.config.mjs")).toBe(true)
  })

  test("eslint.config.cjs", () => {
    expect(isEslintConfigFile("eslint.config.cjs")).toBe(true)
  })

  test("eslint.config.ts", () => {
    expect(isEslintConfigFile("eslint.config.ts")).toBe(true)
  })

  test("eslint.config.mts", () => {
    expect(isEslintConfigFile("eslint.config.mts")).toBe(true)
  })

  test("eslint.config.cts", () => {
    expect(isEslintConfigFile("eslint.config.cts")).toBe(true)
  })

  test("nested path: src/eslint.config.js", () => {
    expect(isEslintConfigFile("src/eslint.config.js")).toBe(true)
  })

  test("nested path: packages/app/eslint.config.ts", () => {
    expect(isEslintConfigFile("packages/app/eslint.config.ts")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// isEslintConfigFile: Legacy .eslintrc formats
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEslintConfigFile: legacy .eslintrc formats", () => {
  test(".eslintrc (no extension)", () => {
    expect(isEslintConfigFile(".eslintrc")).toBe(true)
  })

  test(".eslintrc.json", () => {
    expect(isEslintConfigFile(".eslintrc.json")).toBe(true)
  })

  test(".eslintrc.js", () => {
    expect(isEslintConfigFile(".eslintrc.js")).toBe(true)
  })

  test(".eslintrc.cjs", () => {
    expect(isEslintConfigFile(".eslintrc.cjs")).toBe(true)
  })

  test(".eslintrc.yml", () => {
    expect(isEslintConfigFile(".eslintrc.yml")).toBe(true)
  })

  test(".eslintrc.yaml", () => {
    expect(isEslintConfigFile(".eslintrc.yaml")).toBe(true)
  })

  test("nested path: config/.eslintrc.json", () => {
    expect(isEslintConfigFile("config/.eslintrc.json")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// isEslintConfigFile: Negative cases (should NOT match)
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEslintConfigFile: negative cases", () => {
  test("regular TypeScript file", () => {
    expect(isEslintConfigFile("src/index.ts")).toBe(false)
  })

  test("regular JavaScript file", () => {
    expect(isEslintConfigFile("src/utils.js")).toBe(false)
  })

  test("package.json", () => {
    expect(isEslintConfigFile("package.json")).toBe(false)
  })

  test("tsconfig.json", () => {
    expect(isEslintConfigFile("tsconfig.json")).toBe(false)
  })

  test("not-eslint.config.js (similar name, different prefix)", () => {
    expect(isEslintConfigFile("not-eslint.config.js")).toBe(false)
  })

  test("my-eslint.config.ts (prefixed name)", () => {
    expect(isEslintConfigFile("my-eslint.config.ts")).toBe(false)
  })

  test("eslint.config.json (unsupported extension)", () => {
    expect(isEslintConfigFile("eslint.config.json")).toBe(false)
  })

  test("eslint.config.yaml (unsupported for flat config)", () => {
    expect(isEslintConfigFile("eslint.config.yaml")).toBe(false)
  })

  test(".eslintrc.ts (unsupported legacy extension)", () => {
    expect(isEslintConfigFile(".eslintrc.ts")).toBe(false)
  })

  test(".eslintrc.mjs (unsupported legacy extension)", () => {
    expect(isEslintConfigFile(".eslintrc.mjs")).toBe(false)
  })

  test("eslintrc.json (missing dot prefix for legacy)", () => {
    expect(isEslintConfigFile("eslintrc.json")).toBe(false)
  })

  test("empty string", () => {
    expect(isEslintConfigFile("")).toBe(false)
  })

  test("eslint.config (no extension)", () => {
    expect(isEslintConfigFile("eslint.config")).toBe(false)
  })

  test(".eslint.config.js (spurious dot prefix)", () => {
    expect(isEslintConfigFile(".eslint.config.js")).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// countEnforcements: keyword counting
// ═══════════════════════════════════════════════════════════════════════════════

describe("countEnforcements", () => {
  test("counts quoted 'warning' keywords", () => {
    const r = countEnforcements('"no-unused-vars": "warning", "semi": "warning"')
    expect(r.warnings).toBe(2)
    expect(r.errors).toBe(0)
  })

  test("counts quoted 'error' keywords", () => {
    const r = countEnforcements('"no-unused-vars": "error", "semi": "error"')
    expect(r.warnings).toBe(0)
    expect(r.errors).toBe(2)
  })

  test("counts 'off' as errors", () => {
    const r = countEnforcements('"no-unused-vars": "off"')
    expect(r.warnings).toBe(0)
    expect(r.errors).toBe(1)
  })

  test("counts 'warn' as warnings", () => {
    const r = countEnforcements('"no-unused-vars": "warn"')
    expect(r.warnings).toBe(1)
    expect(r.errors).toBe(0)
  })

  test("counts mixed warning and error keywords", () => {
    const r = countEnforcements('"a": "warning", "b": "error", "c": "off", "d": "warn"')
    expect(r.warnings).toBe(2) // "warning" + "warn"
    expect(r.errors).toBe(2) // "error" + "off"
  })

  test("empty string returns zero counts", () => {
    const r = countEnforcements("")
    expect(r.warnings).toBe(0)
    expect(r.errors).toBe(0)
  })

  test("content without eslint keywords returns zero", () => {
    const r = countEnforcements('{"name": "my-app", "version": "1.0.0"}')
    expect(r.warnings).toBe(0)
    expect(r.errors).toBe(0)
  })

  test("single-quoted values are counted", () => {
    const r = countEnforcements("'no-unused-vars': 'warning', 'semi': 'error'")
    expect(r.warnings).toBe(1)
    expect(r.errors).toBe(1)
  })

  test("case insensitive matching", () => {
    const r = countEnforcements('"a": "WARNING", "b": "Error", "c": "OFF"')
    expect(r.warnings).toBe(1)
    expect(r.errors).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// PreToolUse hook handler (via subprocess invocation)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the hook as a subprocess by invoking it with Bun.
 * Simulates the real PreToolUse environment.
 */
async function invokeHook(input: {
  tool_name: string
  tool_input?: {
    file_path?: string
    old_string?: string
    new_string?: string
  }
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", "hooks/pretooluse-eslint-config-strength.ts"], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: neutralAgentEnv(),
  })
  await proc.stdin.write(JSON.stringify(input))
  await proc.stdin.end()
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

describe("pretooluse-eslint-config-strength: hook handler logic", () => {
  test("allows non-ESLint config files (early exit)", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/index.ts",
        old_string: "export const x = 1",
        new_string: "export const x = 2",
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("allows new ESLint config files (no old_string)", async () => {
    const input = {
      tool_name: "Write",
      tool_input: {
        file_path: "eslint.config.js",
        new_string: 'export default [{ rules: { "semi": "error" } }]',
      },
    }
    const { exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
  })

  test("denies edit that decreases warning count", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '{"rules": {"semi": "warning", "quotes": "warning"}}',
        new_string: '{"rules": {"semi": "warning"}}',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    const json = JSON.parse(stdout)
    expect(json.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(stdout).toContain("Warning count decreased from 2 to 1")
  })

  test("denies edit that removes enforced rules (decreases error count)", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "eslint.config.js",
        old_string:
          'export default [{ rules: { "semi": "error", "quotes": "error", "indent": "error" } }]',
        new_string: 'export default [{ rules: { "semi": "error", "quotes": "error" } }]',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    const json = JSON.parse(stdout)
    expect(json.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(stdout).toContain("Enforcement count decreased")
  })

  test("allows edit that keeps warnings and adds new errors", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '{"rules": {"semi": "warning"}}',
        new_string: '{"rules": {"semi": "warning", "quotes": "error"}}',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    const json = JSON.parse(stdout)
    expect(json.hookSpecificOutput.permissionDecision).toBe("allow")
  })

  test("allows edit that adds new rules (strengthens config)", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '{"rules": {"semi": "error"}}',
        new_string: '{"rules": {"semi": "error", "quotes": "error", "indent": "error"}}',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    expect(stdout).toContain("allow")
  })

  test("allows edit with same enforcement count (no weakening)", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "eslint.config.js",
        old_string: 'export default [{ rules: { "semi": "error", "quotes": "warning" } }]',
        new_string: 'export default [{ rules: { "semi": "error", "quotes": "error" } }]',
      },
    }
    const { exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
  })

  test("hook output is valid JSON with allow decision", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '{"rules": {"semi": "error"}}',
        new_string: '{"rules": {"semi": "error", "quotes": "error"}}',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    const json = JSON.parse(stdout)
    expect(json.hookSpecificOutput).toBeDefined()
    expect(json.hookSpecificOutput.hookEventName).toBe("PreToolUse")
    expect(json.hookSpecificOutput.permissionDecision).toBe("allow")
  })

  test("denies edit on legacy .eslintrc with weakened rules", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc",
        old_string: '{"rules": {"semi": "error", "quotes": "error"}}',
        new_string: '{"rules": {"semi": "error"}}',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    const json = JSON.parse(stdout)
    expect(json.hookSpecificOutput.permissionDecision).toBe("deny")
  })

  // ─── Edge-case & sad-path tests (TDD audit Task #29) ────────────────────────

  test("early exit when tool_input is entirely missing", async () => {
    const input = { tool_name: "Edit" }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("early exit when old_string is explicitly empty string", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "eslint.config.ts",
        old_string: "",
        new_string: '{ rules: { "semi": "error" } }',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
  })

  test("uses content fallback when new_string is absent (Write tool)", async () => {
    const input = {
      tool_name: "Write",
      tool_input: {
        file_path: "eslint.config.js",
        old_string: '{ rules: { "semi": "error", "quotes": "error" } }',
        content: '{ rules: { "semi": "error", "quotes": "error", "indent": "error" } }',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    const json = JSON.parse(stdout)
    expect(json.hookSpecificOutput.permissionDecision).toBe("allow")
  })

  test("denies when single warning removed (1→0 boundary)", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '{"rules": {"semi": "warning"}}',
        new_string: '{"rules": {}}',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    const json = JSON.parse(stdout)
    expect(json.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(stdout).toContain("Warning count decreased from 1 to 0")
  })

  test("warning denial fires first when both warnings and errors decrease", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "eslint.config.js",
        old_string:
          '{ rules: { "semi": "warning", "quotes": "warning", "indent": "error", "no-var": "error" } }',
        new_string: '{ rules: { "semi": "warning" } }',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    const json = JSON.parse(stdout)
    expect(json.hookSpecificOutput.permissionDecision).toBe("deny")
    // Warning check at line 50 fires before error check at line 70
    expect(stdout).toContain("Warning count decreased")
    expect(stdout).not.toContain("Enforcement count decreased")
  })

  test("deny reason includes 'Rules cannot be weakened' text", async () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '{"rules": {"semi": "error", "quotes": "error", "indent": "error"}}',
        new_string: '{"rules": {"semi": "error"}}',
      },
    }
    const { stdout, exitCode } = await invokeHook(input)
    expect(exitCode).toBe(0)
    const json = JSON.parse(stdout)
    expect(json.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(json.hookSpecificOutput.permissionDecisionReason).toContain("Rules cannot be weakened")
    expect(json.hookSpecificOutput.permissionDecisionReason).toContain("quality bar never lowers")
  })

  test("error handler catches malformed stdin and exits non-zero", async () => {
    const proc = Bun.spawn(["bun", "hooks/pretooluse-eslint-config-strength.ts"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: neutralAgentEnv(),
    })
    await proc.stdin.write("NOT VALID JSON")
    await proc.stdin.end()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    expect(proc.exitCode).toBe(1)
    expect(stderr).toContain("Hook error:")
  })
})

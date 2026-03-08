import { describe, expect, test } from "bun:test"
import { scanContentForSecrets } from "../hooks/pretooluse-no-secrets.ts"

// Build secret strings via array joins to avoid triggering the hook or
// GitHub push protection when editing this file.
const FAKE_PRIVATE_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "abc123",
  "-----END RSA PRIVATE KEY-----",
].join("\n")
const FAKE_AWS_KEY = ["AKIA", "ABCDEFGHIJ", "KLMNOP"].join("") // 20 chars after AKIA → valid format
const FAKE_GH_TOKEN = ["ghp_", "A".repeat(36)].join("")
const FAKE_SLACK_TOKEN = ["xoxb", "-1234567890-abcdefghijklmn"].join("")
// OpenAI-style key — 32+ alphanum after prefix
const FAKE_SK_KEY = ["sk-", "a".repeat(32)].join("")
const FAKE_STRIPE_LIVE = ["sk_live_", "a".repeat(24)].join("")

describe("scanContentForSecrets", () => {
  test("returns empty for clean content", () => {
    const content = `const x = 1\nconst y = "hello"\nexport { x, y }`
    expect(scanContentForSecrets(content, "src/foo.ts")).toEqual([])
  })

  test("detects private key header", () => {
    const findings = scanContentForSecrets(FAKE_PRIVATE_KEY, "src/foo.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("private-key")
  })

  test("detects AWS access key ID", () => {
    const content = `const key = "${FAKE_AWS_KEY}"`
    const findings = scanContentForSecrets(content, "src/config.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("token")
  })

  test("detects GitHub personal access token", () => {
    const content = `const token = "${FAKE_GH_TOKEN}"`
    const findings = scanContentForSecrets(content, "src/api.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("token")
  })

  test("detects Slack bot token", () => {
    const content = `const slackToken = "${FAKE_SLACK_TOKEN}"`
    const findings = scanContentForSecrets(content, "src/slack.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("token")
  })

  test("detects generic API key assignment", () => {
    const content = `api_key = "super-secret-value-12345678"`
    const findings = scanContentForSecrets(content, "src/config.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("generic-secret")
  })

  test("detects generic password assignment", () => {
    const content = `const config = { password: "my-real-password-123" }`
    const findings = scanContentForSecrets(content, "src/db.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("generic-secret")
  })

  test("detects access_token assignment", () => {
    const content = `access_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"`
    const findings = scanContentForSecrets(content, "src/auth.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("generic-secret")
  })

  test("ignores generic secret with placeholder value", () => {
    const content = `api_key = "your-api-key-here"`
    expect(scanContentForSecrets(content, "src/config.ts")).toEqual([])
  })

  test("ignores generic secret with example placeholder", () => {
    const content = `api_key = "example-key-12345678"`
    expect(scanContentForSecrets(content, "src/config.ts")).toEqual([])
  })

  test("ignores generic secret with dummy placeholder", () => {
    const content = `password = "dummy-password-value"`
    expect(scanContentForSecrets(content, "src/config.ts")).toEqual([])
  })

  test("ignores generic secret with xxxx placeholder", () => {
    const content = `api_key = "xxxx-not-real-xxxx"`
    expect(scanContentForSecrets(content, "src/config.ts")).toEqual([])
  })

  test("ignores env. reference pattern", () => {
    const content = `api_key = "env.MY_API_KEY"`
    expect(scanContentForSecrets(content, "src/config.ts")).toEqual([])
  })

  test("ignores not-needed placeholder", () => {
    const content = `password = "not-needed-in-tests"`
    expect(scanContentForSecrets(content, "src/config.ts")).toEqual([])
  })

  test("returns empty for test files (any secret pattern)", () => {
    // Test files are excluded — they legitimately contain fake credentials
    const content = `const fakeKey = "${FAKE_GH_TOKEN}"\nconst fakeAws = "${FAKE_AWS_KEY}"`
    expect(scanContentForSecrets(content, "src/auth.test.ts")).toEqual([])
  })

  test("returns empty for spec files", () => {
    const content = `api_key = "real-looking-secret-value-1234"`
    expect(scanContentForSecrets(content, "src/config.spec.ts")).toEqual([])
  })

  test("caps findings at 10 lines", () => {
    // Generate 15 lines each with a private key header
    const lines = Array.from({ length: 15 }, () => FAKE_PRIVATE_KEY.split("\n")[0]!).join("\n")
    const findings = scanContentForSecrets(lines, "src/foo.ts")
    expect(findings.length).toBeLessThanOrEqual(10)
  })

  test("returns empty for empty content", () => {
    expect(scanContentForSecrets("", "src/foo.ts")).toEqual([])
  })

  test("returns empty for content without secrets", () => {
    const content = [
      "import { foo } from './foo'",
      "",
      "export function bar() {",
      "  return foo()",
      "}",
    ].join("\n")
    expect(scanContentForSecrets(content, "src/bar.ts")).toEqual([])
  })

  test("short generic secret value (< 8 chars) is not flagged", () => {
    // GENERIC_SECRET_RE requires 8+ chars in the quoted value
    const content = `password = "short"`
    expect(scanContentForSecrets(content, "src/config.ts")).toEqual([])
  })

  test("detects multiple findings in one file", () => {
    const content = [
      `const key = "${FAKE_AWS_KEY}"`,
      `password = "super-secret-password-here"`,
    ].join("\n")
    const findings = scanContentForSecrets(content, "src/config.ts")
    expect(findings.length).toBe(2)
  })

  test("detects EC private key variant", () => {
    const content = "-----BEGIN EC PRIVATE KEY-----\nabc123\n-----END EC PRIVATE KEY-----"
    const findings = scanContentForSecrets(content, "src/cert.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("private-key")
  })

  test("detects OPENSSH private key variant", () => {
    const content =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb64data\n-----END OPENSSH PRIVATE KEY-----"
    const findings = scanContentForSecrets(content, "src/key.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("private-key")
  })

  test("detects OpenAI-style sk- token", () => {
    const content = `const apiKey = "${FAKE_SK_KEY}"`
    const findings = scanContentForSecrets(content, "src/ai.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("token")
  })

  test("detects Stripe live key", () => {
    const content = `const stripeKey = "${FAKE_STRIPE_LIVE}"`
    const findings = scanContentForSecrets(content, "src/payments.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe("token")
  })
})

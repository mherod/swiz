import { describe, expect, it } from "bun:test"

// Test the pure utility functions extracted from check-branch-policy.ts

const DOCS_CONFIG_RE =
  /\.(md|txt|json|ya?ml|toml)$|\.config\.[jt]s$|\.env\.example$|LICENSE|^\.github\/|^\.husky\//

function isDocsOrConfig(filePath: string): boolean {
  return DOCS_CONFIG_RE.test(filePath)
}

function parseCommitType(message: string): string | null {
  const match = message.match(/^(\w+)(\(.+?\))?[!]?:/)
  return match?.[1] ?? null
}

describe("isDocsOrConfig", () => {
  it("matches markdown files", () => {
    expect(isDocsOrConfig("README.md")).toBe(true)
    expect(isDocsOrConfig("docs/guide.md")).toBe(true)
  })

  it("matches JSON files", () => {
    expect(isDocsOrConfig("package.json")).toBe(true)
    expect(isDocsOrConfig("tsconfig.json")).toBe(true)
  })

  it("matches YAML files", () => {
    expect(isDocsOrConfig("config.yaml")).toBe(true)
    expect(isDocsOrConfig("config.yml")).toBe(true)
  })

  it("matches TOML files", () => {
    expect(isDocsOrConfig("pyproject.toml")).toBe(true)
  })

  it("matches config JS/TS files", () => {
    expect(isDocsOrConfig("eslint.config.js")).toBe(true)
    expect(isDocsOrConfig("vitest.config.ts")).toBe(true)
  })

  it("matches .env.example", () => {
    expect(isDocsOrConfig(".env.example")).toBe(true)
  })

  it("matches LICENSE", () => {
    expect(isDocsOrConfig("LICENSE")).toBe(true)
  })

  it("matches .github/ paths", () => {
    expect(isDocsOrConfig(".github/workflows/ci.yml")).toBe(true)
  })

  it("matches .husky/ paths", () => {
    expect(isDocsOrConfig(".husky/pre-commit")).toBe(true)
  })

  it("does NOT match source files", () => {
    expect(isDocsOrConfig("src/index.ts")).toBe(false)
    expect(isDocsOrConfig("hooks/my-hook.ts")).toBe(false)
    expect(isDocsOrConfig("lib/utils.js")).toBe(false)
  })

  it("does NOT match test files", () => {
    expect(isDocsOrConfig("src/foo.test.ts")).toBe(false)
  })

  it("matches text files", () => {
    expect(isDocsOrConfig("CHANGELOG.txt")).toBe(true)
  })
})

describe("parseCommitType", () => {
  it("parses standard types", () => {
    expect(parseCommitType("feat: add new feature")).toBe("feat")
    expect(parseCommitType("fix: resolve bug")).toBe("fix")
    expect(parseCommitType("docs: update readme")).toBe("docs")
    expect(parseCommitType("refactor: simplify logic")).toBe("refactor")
  })

  it("parses types with scope", () => {
    expect(parseCommitType("feat(api): add endpoint")).toBe("feat")
    expect(parseCommitType("fix(auth): correct token")).toBe("fix")
  })

  it("parses breaking change indicator", () => {
    expect(parseCommitType("feat!: breaking change")).toBe("feat")
    expect(parseCommitType("feat(api)!: breaking")).toBe("feat")
  })

  it("returns null for non-conventional messages", () => {
    expect(parseCommitType("updated some stuff")).toBeNull()
    expect(parseCommitType("WIP")).toBeNull()
    expect(parseCommitType("")).toBeNull()
  })
})

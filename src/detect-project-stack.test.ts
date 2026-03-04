import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _clearFrameworkCache, detectProjectStack } from "./detect-frameworks.ts"

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "swiz-detect-project-stack-"))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true })
})

afterEach(() => {
  _clearFrameworkCache()
})

async function fixture(name: string): Promise<string> {
  const dir = join(tmpDir, name)
  await mkdir(dir, { recursive: true })
  return dir
}

// ─── Bun ─────────────────────────────────────────────────────────────────────

describe("bun stack detection", () => {
  it("detects bun from bun.lockb", async () => {
    const dir = await fixture("bun-lockb")
    await Bun.write(join(dir, "bun.lockb"), "")
    await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "app" }))
    expect(detectProjectStack(dir)).toEqual(["bun"])
  })

  it("detects bun from bun.lock", async () => {
    const dir = await fixture("bun-lock")
    await Bun.write(join(dir, "bun.lock"), "")
    await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "app" }))
    expect(detectProjectStack(dir)).toEqual(["bun"])
  })

  it("bun takes priority over node when bun.lockb + package.json both present", async () => {
    const dir = await fixture("bun-priority")
    await Bun.write(join(dir, "bun.lockb"), "")
    await Bun.write(join(dir, "package.json"), JSON.stringify({}))
    const stacks = detectProjectStack(dir)
    expect(stacks).toContain("bun")
    expect(stacks).not.toContain("node")
  })
})

// ─── Node ────────────────────────────────────────────────────────────────────

describe("node stack detection", () => {
  it("detects node from package.json without bun lockfile", async () => {
    const dir = await fixture("node-pkg")
    await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "app" }))
    expect(detectProjectStack(dir)).toEqual(["node"])
  })

  it("does not detect node when no package.json", async () => {
    const dir = await fixture("node-absent")
    expect(detectProjectStack(dir)).not.toContain("node")
  })
})

// ─── Go ──────────────────────────────────────────────────────────────────────

describe("go stack detection", () => {
  it("detects go from go.mod", async () => {
    const dir = await fixture("go-mod")
    await Bun.write(join(dir, "go.mod"), "module example.com/app\n\ngo 1.21\n")
    expect(detectProjectStack(dir)).toContain("go")
  })
})

// ─── Python ──────────────────────────────────────────────────────────────────

describe("python stack detection", () => {
  it("detects python from pyproject.toml", async () => {
    const dir = await fixture("py-pyproject")
    await Bun.write(join(dir, "pyproject.toml"), "[tool.poetry]\nname = 'app'\n")
    expect(detectProjectStack(dir)).toContain("python")
  })

  it("detects python from setup.py", async () => {
    const dir = await fixture("py-setup")
    await Bun.write(join(dir, "setup.py"), "from setuptools import setup\n")
    expect(detectProjectStack(dir)).toContain("python")
  })

  it("detects python from requirements.txt", async () => {
    const dir = await fixture("py-req")
    await Bun.write(join(dir, "requirements.txt"), "django==4.2\n")
    expect(detectProjectStack(dir)).toContain("python")
  })
})

// ─── Ruby ─────────────────────────────────────────────────────────────────────

describe("ruby stack detection", () => {
  it("detects ruby from Gemfile", async () => {
    const dir = await fixture("ruby-gemfile")
    await Bun.write(join(dir, "Gemfile"), "source 'https://rubygems.org'\n")
    expect(detectProjectStack(dir)).toContain("ruby")
  })
})

// ─── Rust ─────────────────────────────────────────────────────────────────────

describe("rust stack detection", () => {
  it("detects rust from Cargo.toml", async () => {
    const dir = await fixture("rust-cargo")
    await Bun.write(join(dir, "Cargo.toml"), "[package]\nname = 'app'\n")
    expect(detectProjectStack(dir)).toContain("rust")
  })
})

// ─── Java ─────────────────────────────────────────────────────────────────────

describe("java stack detection", () => {
  it("detects java from pom.xml", async () => {
    const dir = await fixture("java-pom")
    await Bun.write(join(dir, "pom.xml"), "<project></project>")
    expect(detectProjectStack(dir)).toContain("java")
  })

  it("detects java from build.gradle", async () => {
    const dir = await fixture("java-gradle")
    await Bun.write(join(dir, "build.gradle"), "plugins { id 'java' }")
    expect(detectProjectStack(dir)).toContain("java")
  })
})

// ─── PHP ──────────────────────────────────────────────────────────────────────

describe("php stack detection", () => {
  it("detects php from composer.json", async () => {
    const dir = await fixture("php-composer")
    await Bun.write(join(dir, "composer.json"), JSON.stringify({ require: { php: ">=8.1" } }))
    expect(detectProjectStack(dir)).toContain("php")
  })
})

// ─── Empty / unknown ─────────────────────────────────────────────────────────

describe("empty project", () => {
  it("returns empty array for directory with no indicator files", async () => {
    const dir = await fixture("empty-stack")
    expect(detectProjectStack(dir)).toEqual([])
  })
})

// ─── Multi-stack (polyglot) ──────────────────────────────────────────────────

describe("polyglot project", () => {
  it("detects multiple stacks simultaneously", async () => {
    const dir = await fixture("polyglot")
    await Bun.write(join(dir, "go.mod"), "module example.com/app\n\ngo 1.21\n")
    await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "frontend" }))
    const stacks = detectProjectStack(dir)
    expect(stacks).toContain("go")
    expect(stacks).toContain("node")
  })

  it("result is sorted", async () => {
    const dir = await fixture("sorted-stacks")
    await Bun.write(join(dir, "go.mod"), "module example.com\n\ngo 1.21\n")
    await Bun.write(join(dir, "requirements.txt"), "flask\n")
    const stacks = detectProjectStack(dir)
    expect(stacks).toEqual([...stacks].sort())
  })
})

// ─── Caching ─────────────────────────────────────────────────────────────────

describe("result caching", () => {
  it("returns the same array instance on repeated calls", async () => {
    const dir = await fixture("stack-cache")
    await Bun.write(join(dir, "go.mod"), "module example.com\n\ngo 1.21\n")
    const first = detectProjectStack(dir)
    const second = detectProjectStack(dir)
    expect(first).toBe(second)
  })

  it("cache is cleared by _clearFrameworkCache", async () => {
    const dir = await fixture("stack-clear-cache")
    await Bun.write(join(dir, "go.mod"), "module example.com\n\ngo 1.21\n")
    const first = detectProjectStack(dir)
    _clearFrameworkCache()
    const second = detectProjectStack(dir)
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })
})

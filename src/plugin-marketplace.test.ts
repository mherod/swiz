import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

interface MarketplacePlugin {
  name: string
  source: string
}

interface Marketplace {
  name: string
  plugins: MarketplacePlugin[]
}

describe("plugin marketplace scaffold", () => {
  test("marketplace.json is valid and points to existing plugin paths", () => {
    const repoRoot = process.cwd()
    const marketplacePath = join(repoRoot, ".claude-plugin", "marketplace.json")
    expect(existsSync(marketplacePath)).toBe(true)

    const marketplace = JSON.parse(readFileSync(marketplacePath, "utf-8")) as Marketplace
    expect(marketplace.name).toBe("swiz-marketplace")
    expect(marketplace.plugins.length).toBeGreaterThan(0)

    for (const plugin of marketplace.plugins) {
      const pluginPath = join(repoRoot, plugin.source)
      expect(existsSync(pluginPath)).toBe(true)
      expect(existsSync(join(pluginPath, ".claude-plugin", "plugin.json"))).toBe(true)
    }
  })

  test("swiz-core plugin exposes install command and auto-continue skills", () => {
    const repoRoot = process.cwd()
    const pluginRoot = join(repoRoot, "plugins", "swiz-core")

    const installCommandPath = join(pluginRoot, "commands", "install.md")
    expect(existsSync(installCommandPath)).toBe(true)
    expect(readFileSync(installCommandPath, "utf-8")).toContain("swiz install")

    const enableSkillPath = join(pluginRoot, "skills", "enable-auto-continue", "SKILL.md")
    const disableSkillPath = join(pluginRoot, "skills", "disable-auto-continue", "SKILL.md")
    expect(existsSync(enableSkillPath)).toBe(true)
    expect(existsSync(disableSkillPath)).toBe(true)
    expect(readFileSync(enableSkillPath, "utf-8")).toContain("swiz settings enable auto-continue")
    expect(readFileSync(disableSkillPath, "utf-8")).toContain("swiz settings disable auto-continue")
  })
})

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import extract from "extract-zip"
import { Zip, ZipPassThrough } from "fflate"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "swiz-archive-security-"))
  roots.push(root)
  const dir = join(root, "output")
  await mkdir(dir)
  return { root, dir, archive: join(root, "fixture.zip") }
}

function archiveBytes(entries: Array<{ name: string; text: string; mode?: number }>) {
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, data) => {
    if (error) throw error
    chunks.push(data)
  })
  for (const { name, text, mode = 0o100644 } of entries) {
    const entry = new ZipPassThrough(name)
    entry.os = 3
    entry.attrs = (mode << 16) >>> 0
    zip.add(entry)
    entry.push(new TextEncoder().encode(text), true)
  }
  zip.end()
  return Buffer.concat(chunks)
}

test("patched extractor preserves regular files and executable modes", async () => {
  const { dir, archive } = await fixture()
  await Bun.write(archive, archiveBytes([{ name: "bin/rg", text: "binary", mode: 0o100755 }]))
  await extract(archive, { dir })
  expect(await Bun.file(join(dir, "bin/rg")).text()).toBe("binary")
  expect((await stat(join(dir, "bin/rg"))).mode & 0o777).toBe(0o755)
})

test.each([
  "../outside",
  "/tmp/swiz-archive-outside",
])("rejects archive symlinks targeting %s", async (target) => {
  const { dir, archive } = await fixture()
  await Bun.write(archive, archiveBytes([{ name: "link", text: target, mode: 0o120777 }]))
  await expect(extract(archive, { dir })).rejects.toThrow("Symlink entry is not allowed")
})

test("rejects a symlink followed by a regular file with the same name", async () => {
  const { root, dir, archive } = await fixture()
  const outside = join(root, "outside")
  await Bun.write(outside, "unchanged")
  await Bun.write(
    archive,
    archiveBytes([
      { name: "duplicate", text: outside, mode: 0o120777 },
      { name: "duplicate", text: "overwrite" },
    ])
  )
  await expect(extract(archive, { dir })).rejects.toThrow("Symlink entry is not allowed")
  expect(await Bun.file(outside).text()).toBe("unchanged")
})

test.each([
  false,
  true,
])("rejects an existing destination symlink (dangling=%s)", async (dangling) => {
  const { root, dir, archive } = await fixture()
  const outside = join(root, "outside")
  if (!dangling) await Bun.write(outside, "unchanged")
  await symlink(outside, join(dir, "target"))
  await Bun.write(archive, archiveBytes([{ name: "target", text: "overwrite" }]))
  await expect(extract(archive, { dir })).rejects.toThrow()
  if (dangling) expect(await Bun.file(outside).exists()).toBe(false)
  else expect(await Bun.file(outside).text()).toBe("unchanged")
})

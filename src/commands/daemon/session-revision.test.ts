import { describe, expect, test } from "bun:test"
import { computeContentRevision, scopeRevisionToWindow } from "./session-data.ts"

/**
 * The revision is the dashboard's only signal that transcript content is unchanged, so a
 * revision that fails to move is worse than the O(n) comparison it replaces: the transcript
 * silently stops updating. These cases pin each visible-change class the client must not miss.
 *
 * Real fingerprints are NUL-separated (see `messageFallbackKey`). These fixtures use plain
 * distinct strings instead — the revision only ever hashes them, and embedding a raw NUL would
 * make this source file binary to Git.
 */
const base = {
  mtimeMs: 1_700_000_000_000,
  size: 4096,
  messageCount: 12,
  lastMessageFingerprint: "fingerprint-hello",
  lastToolCallFingerprint: "Read:src/index.ts",
}

describe("computeContentRevision", () => {
  test("is stable for identical content so unchanged polls compare equal", () => {
    expect(computeContentRevision(base)).toBe(computeContentRevision({ ...base }))
  })

  test("changes on append, which moves both size and message count", () => {
    const appended = { ...base, size: base.size + 128, messageCount: base.messageCount + 1 }
    expect(computeContentRevision(appended)).not.toBe(computeContentRevision(base))
  })

  test("changes on a same-length edit, which moves mtime but not size", () => {
    const edited = { ...base, mtimeMs: base.mtimeMs + 1 }
    expect(edited.size).toBe(base.size)
    expect(computeContentRevision(edited)).not.toBe(computeContentRevision(base))
  })

  test("changes on deletion, which shrinks size and message count", () => {
    const deleted = { ...base, size: base.size - 128, messageCount: base.messageCount - 1 }
    expect(computeContentRevision(deleted)).not.toBe(computeContentRevision(base))
  })

  test("changes on reorder even at identical size, mtime and count", () => {
    // A reorder keeps byte count and message count, so only the trailing fingerprint separates it.
    const reordered = { ...base, lastMessageFingerprint: "fingerprint-goodbye" }
    expect(reordered.size).toBe(base.size)
    expect(reordered.messageCount).toBe(base.messageCount)
    expect(computeContentRevision(reordered)).not.toBe(computeContentRevision(base))
  })

  test("changes when only tool call content differs", () => {
    const toolChanged = { ...base, lastToolCallFingerprint: "Read:src/other.ts" }
    expect(computeContentRevision(toolChanged)).not.toBe(computeContentRevision(base))
  })

  test("exposes no transcript text, path, or session id", () => {
    const revision = computeContentRevision(base)
    expect(revision).not.toContain("hello")
    expect(revision).not.toContain("src/index.ts")
    expect(revision).not.toContain("fingerprint")
    // Digest-and-counter shape only.
    expect(revision).toMatch(/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/)
  })

  test("tolerates absent fingerprints without collapsing distinct content", () => {
    const noFingerprints = {
      mtimeMs: base.mtimeMs,
      size: base.size,
      messageCount: base.messageCount,
    }
    expect(computeContentRevision(noFingerprints)).toBe(
      computeContentRevision({ ...noFingerprints })
    )
    expect(computeContentRevision(noFingerprints)).not.toBe(computeContentRevision(base))
  })
})

describe("scopeRevisionToWindow", () => {
  test("separates clients polling the same session with different limits", () => {
    const revision = computeContentRevision(base)
    expect(scopeRevisionToWindow(revision, 30)).not.toBe(scopeRevisionToWindow(revision, 150))
  })

  test("is stable for the same content and window", () => {
    const revision = computeContentRevision(base)
    expect(scopeRevisionToWindow(revision, 150)).toBe(scopeRevisionToWindow(revision, 150))
  })

  test("changes when live captured tool calls change without the file changing", () => {
    const revision = computeContentRevision(base)
    expect(scopeRevisionToWindow(revision, 150, "abc")).not.toBe(
      scopeRevisionToWindow(revision, 150, "def")
    )
    // Control: the same signature still compares equal.
    expect(scopeRevisionToWindow(revision, 150, "abc")).toBe(
      scopeRevisionToWindow(revision, 150, "abc")
    )
  })

  test("stays undefined when the session had no cached revision", () => {
    // An unresolved session must not emit a revision, or the client would treat the empty
    // transcript as authoritative and stop updating.
    expect(scopeRevisionToWindow(undefined, 150)).toBeUndefined()
  })
})

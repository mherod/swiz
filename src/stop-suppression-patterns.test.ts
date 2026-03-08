import { describe, expect, test } from "bun:test"
import { scanDiffForSuppressions } from "../hooks/stop-suppression-patterns.ts"

// Build keyword strings the same way the hook does to avoid triggering
// the pretooluse hooks when editing this test file.
const KW_IGNORE = ["ts", "ignore"].join("-")
const KW_NOCHECK = ["ts", "nocheck"].join("-")
const KW_EXPECT = ["ts", "expect", "error"].join("-")
const KW_LINT = ["eslint", "disable"].join("-")

describe("scanDiffForSuppressions", () => {
  test("returns null for empty diff", () => {
    expect(scanDiffForSuppressions("")).toBeNull()
  })

  test("returns null for diff with no suppression patterns", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const x = 1
+const y = 2
 export { x }`
    expect(scanDiffForSuppressions(diff)).toBeNull()
  })

  test(`detects added @${KW_IGNORE}`, () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const x = 1
+// @${KW_IGNORE}
+const y: string = 42
 export { x }`
    const result = scanDiffForSuppressions(diff)
    expect(result).not.toBeNull()
    expect(result!.affectedFiles).toEqual(["src/foo.ts"])
    expect(result!.matchingLines).toHaveLength(1)
    expect(result!.matchingLines[0]).toContain(`@${KW_IGNORE}`)
  })

  test(`detects added @${KW_NOCHECK}`, () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
+// @${KW_NOCHECK}
 const x = 1
 export { x }`
    const result = scanDiffForSuppressions(diff)
    expect(result).not.toBeNull()
    expect(result!.matchingLines[0]).toContain(`@${KW_NOCHECK}`)
  })

  test(`detects bare @${KW_EXPECT} (no description)`, () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const x = 1
+// @${KW_EXPECT}
+const y: string = 42
 export { x }`
    const result = scanDiffForSuppressions(diff)
    expect(result).not.toBeNull()
    expect(result!.matchingLines[0]).toContain(`@${KW_EXPECT}`)
  })

  test(`allows @${KW_EXPECT} with a description`, () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const x = 1
+// @${KW_EXPECT}: upstream types missing overload
+const y: string = 42
 export { x }`
    expect(scanDiffForSuppressions(diff)).toBeNull()
  })

  test(`detects ${KW_LINT} in line comment form`, () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
+// ${KW_LINT}
 const x = 1
 export { x }`
    const result = scanDiffForSuppressions(diff)
    expect(result).not.toBeNull()
    expect(result!.matchingLines[0]).toContain(KW_LINT)
  })

  test(`detects ${KW_LINT} in block comment form`, () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
+/* ${KW_LINT} */
 const x = 1
 export { x }`
    const result = scanDiffForSuppressions(diff)
    expect(result).not.toBeNull()
    expect(result!.matchingLines[0]).toContain(KW_LINT)
  })

  test("detects `as any` cast", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
+const x = getValue() as any
 const y = 1
 export { y }`
    const result = scanDiffForSuppressions(diff)
    expect(result).not.toBeNull()
    expect(result!.matchingLines[0]).toContain("as any")
  })

  test("ignores removed lines containing suppression patterns", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,2 @@
-// @${KW_IGNORE}
 const x = 1
 export { x }`
    expect(scanDiffForSuppressions(diff)).toBeNull()
  })

  test("ignores context lines containing suppression patterns", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 // @${KW_IGNORE}
 const x = 1
+const y = 2
 export { x }`
    expect(scanDiffForSuppressions(diff)).toBeNull()
  })

  test("ignores non-TypeScript/JavaScript files", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,2 +1,3 @@
+# @${KW_IGNORE}
 name: CI
 on: push`
    expect(scanDiffForSuppressions(diff)).toBeNull()
  })

  test("ignores shell script files", () => {
    const diff = `diff --git a/scripts/setup.sh b/scripts/setup.sh
--- a/scripts/setup.sh
+++ b/scripts/setup.sh
@@ -1,2 +1,3 @@
+# @${KW_IGNORE}
 echo hello`
    expect(scanDiffForSuppressions(diff)).toBeNull()
  })

  test("does not match +++ header as a suppression line", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
+const x = 2
 export {}`
    expect(scanDiffForSuppressions(diff)).toBeNull()
  })

  test("handles multiple files with violations", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
+// @${KW_IGNORE}
 export {}
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,3 @@
+const x = val() as any
 export {}`
    const result = scanDiffForSuppressions(diff)
    expect(result).not.toBeNull()
    expect(result!.affectedFiles).toEqual(["src/foo.ts", "src/bar.ts"])
    expect(result!.matchingLines).toHaveLength(2)
  })

  test("handles .tsx files", () => {
    const diff = `diff --git a/src/Component.tsx b/src/Component.tsx
--- a/src/Component.tsx
+++ b/src/Component.tsx
@@ -1,2 +1,3 @@
+// @${KW_IGNORE}
 export {}`
    const result = scanDiffForSuppressions(diff)
    expect(result).not.toBeNull()
    expect(result!.affectedFiles).toEqual(["src/Component.tsx"])
  })

  test("handles .js and .jsx files", () => {
    const diff = `diff --git a/src/util.js b/src/util.js
--- a/src/util.js
+++ b/src/util.js
@@ -1,2 +1,3 @@
+const x = val() as any
 module.exports = {}`
    const result = scanDiffForSuppressions(diff)
    expect(result).not.toBeNull()
    expect(result!.affectedFiles).toEqual(["src/util.js"])
  })
})

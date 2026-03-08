import { describe, expect, test } from "bun:test"
import { scanDiffForPermissions } from "../hooks/stop-workflow-permissions.ts"

describe("scanDiffForPermissions", () => {
  test("returns null for empty diff", () => {
    expect(scanDiffForPermissions("")).toBeNull()
  })

  test("returns null for diff with no permissions changes", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -10,3 +10,4 @@ jobs:
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
+      - run: echo hello`
    expect(scanDiffForPermissions(diff)).toBeNull()
  })

  test("detects added top-level permissions block", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,5 @@
 name: CI
+permissions:
+  contents: read
 on:`
    const result = scanDiffForPermissions(diff)
    expect(result).not.toBeNull()
    expect(result!.affectedFiles).toEqual([".github/workflows/ci.yml"])
    expect(result!.matchingLines).toHaveLength(1)
    expect(result!.matchingLines[0]).toContain("permissions:")
  })

  test("detects permissions: write-all shorthand", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,4 @@
 name: CI
+permissions: write-all
 on:`
    const result = scanDiffForPermissions(diff)
    expect(result).not.toBeNull()
    expect(result!.matchingLines[0]).toContain("permissions: write-all")
  })

  test("detects job-level permissions addition", () => {
    const diff = `diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -5,6 +5,8 @@ jobs:
   deploy:
     runs-on: ubuntu-latest
+    permissions:
+      contents: write
     steps:`
    const result = scanDiffForPermissions(diff)
    expect(result).not.toBeNull()
    expect(result!.affectedFiles).toEqual([".github/workflows/deploy.yml"])
  })

  test("ignores removed permissions lines (only additions matter)", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,4 +1,3 @@
 name: CI
-permissions: write-all
 on:`
    expect(scanDiffForPermissions(diff)).toBeNull()
  })

  test("ignores context lines containing permissions", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,4 +1,5 @@
 name: CI
 permissions: read-all
 on:
+  workflow_dispatch:`
    expect(scanDiffForPermissions(diff)).toBeNull()
  })

  test("handles multiple files with violations", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,4 @@
 name: CI
+permissions: write-all
 on:
diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -1,3 +1,4 @@
 name: Deploy
+permissions: read-all
 on:`
    const result = scanDiffForPermissions(diff)
    expect(result).not.toBeNull()
    expect(result!.affectedFiles).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/deploy.yml",
    ])
    expect(result!.matchingLines).toHaveLength(2)
  })

  test("does not match +++ header as a permission line", () => {
    // +++ b/.github/workflows/ci.yml starts with + but is a diff header
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,4 @@
 name: CI
+  - run: echo done
 on:`
    expect(scanDiffForPermissions(diff)).toBeNull()
  })

  test("detects indented permissions with leading whitespace", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -5,6 +5,8 @@ jobs:
   build:
+      permissions:
+        contents: read
     steps:`
    const result = scanDiffForPermissions(diff)
    expect(result).not.toBeNull()
  })
})

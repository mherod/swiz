import { describe, expect, test } from "bun:test"
import { detectPermissionChanges } from "../scripts/check-workflow-permissions.ts"

describe("detectPermissionChanges", () => {
  test("returns empty for diff with no permissions changes", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -10,3 +10,4 @@ jobs:
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
+      - run: echo hello`
    expect(detectPermissionChanges(diff)).toEqual([])
  })

  test("detects top-level permissions addition", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,5 @@
 name: CI
+permissions:
+  contents: read
 on:`
    const results = detectPermissionChanges(diff)
    expect(results.length).toBe(1)
    expect(results[0]!.file).toBe(".github/workflows/ci.yml")
    expect(results[0]!.line).toBe("permissions:")
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
    const results = detectPermissionChanges(diff)
    expect(results.length).toBe(1)
    expect(results[0]!.line).toBe("permissions:")
  })

  test("detects permissions: write-all shorthand", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,4 @@
 name: CI
+permissions: write-all
 on:`
    const results = detectPermissionChanges(diff)
    expect(results.length).toBe(1)
    expect(results[0]!.line).toBe("permissions: write-all")
  })

  test("ignores removed permissions lines", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,4 +1,3 @@
 name: CI
-permissions: write-all
 on:`
    expect(detectPermissionChanges(diff)).toEqual([])
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
    expect(detectPermissionChanges(diff)).toEqual([])
  })

  test("returns empty for empty diff", () => {
    expect(detectPermissionChanges("")).toEqual([])
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
    const results = detectPermissionChanges(diff)
    expect(results.length).toBe(2)
    expect(results[0]!.file).toBe(".github/workflows/ci.yml")
    expect(results[1]!.file).toBe(".github/workflows/deploy.yml")
  })

  test("tracks line numbers correctly", () => {
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -3,3 +3,5 @@
 on:
   push:
+permissions:
+  contents: write
     branches: [main]`
    const results = detectPermissionChanges(diff)
    expect(results.length).toBe(1)
    expect(results[0]!.lineNumber).toBe(5)
  })
})

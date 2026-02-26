import { describe, test, expect } from "bun:test";

// Test the GENERATED_FILE_RE and EXCLUDE_PATH_RE exclusion logic in isolation,
// mirroring the filter applied in stop-todo-tracker.ts.

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|py|rb|go|java|kt|swift)$/;
const EXCLUDE_PATH_RE = /node_modules|\.claude\/hooks\/|^hooks\/|__tests__|\.test\.|\.spec\./;
const GENERATED_FILE_RE = /main\.dart\.js$|\.dart\.js$|\.min\.js$|\.bundle\.js$|\.chunk\.js$/;

function isScanned(filePath: string): boolean {
  return (
    SOURCE_EXT_RE.test(filePath) &&
    !EXCLUDE_PATH_RE.test(filePath) &&
    !GENERATED_FILE_RE.test(filePath)
  );
}

describe("stop-todo-tracker file filter", () => {
  describe("GENERATED_FILE_RE — compiled artifacts are excluded", () => {
    test("main.dart.js is excluded", () => {
      expect(isScanned("apps/portal/src/main.dart.js")).toBe(false);
    });

    test("nested main.dart.js is excluded", () => {
      expect(isScanned("apps/amp.raptor-london.co.uk/src/main.dart.js")).toBe(false);
    });

    test("any *.dart.js file is excluded", () => {
      expect(isScanned("build/output.dart.js")).toBe(false);
    });

    test("*.min.js is excluded", () => {
      expect(isScanned("public/vendor.min.js")).toBe(false);
    });

    test("*.bundle.js is excluded", () => {
      expect(isScanned("dist/app.bundle.js")).toBe(false);
    });

    test("*.chunk.js is excluded (webpack output)", () => {
      expect(isScanned("dist/123.chunk.js")).toBe(false);
    });
  });

  describe("EXCLUDE_PATH_RE — hooks and test files are excluded", () => {
    test("hooks/ files are excluded", () => {
      expect(isScanned("hooks/stop-todo-tracker.ts")).toBe(false);
    });

    test(".claude/hooks/ files are excluded", () => {
      expect(isScanned(".claude/hooks/stop-something.ts")).toBe(false);
    });

    test("node_modules files are excluded", () => {
      expect(isScanned("node_modules/some-package/index.ts")).toBe(false);
    });

    test("*.test.ts is excluded", () => {
      expect(isScanned("src/utils.test.ts")).toBe(false);
    });

    test("*.spec.js is excluded", () => {
      expect(isScanned("src/utils.spec.js")).toBe(false);
    });

    test("__tests__ directory is excluded", () => {
      expect(isScanned("src/__tests__/utils.ts")).toBe(false);
    });
  });

  describe("normal source files are scanned", () => {
    test("TypeScript source file is scanned", () => {
      expect(isScanned("src/lib/session.ts")).toBe(true);
    });

    test("JavaScript source file is scanned", () => {
      expect(isScanned("src/utils.js")).toBe(true);
    });

    test("Python file is scanned", () => {
      expect(isScanned("scripts/migrate.py")).toBe(true);
    });

    test("regular .js file (not minified/dart) is scanned", () => {
      expect(isScanned("src/analytics.js")).toBe(true);
    });
  });
});

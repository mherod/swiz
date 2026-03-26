import globals from "globals"
import tseslint from "typescript-eslint"

const COMPLEXITY_WARN = "warn"

export default tseslint.config(
  {
    ignores: ["node_modules/**", ".swiz/**", "coverage/**", "dist/**", "**/*.d.ts"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,jsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.browser,
        Bun: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      /** Async functions passed where void is expected (callbacks, JSX handlers). */
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            arguments: true,
            attributes: true,
            properties: true,
            returns: true,
            variables: true,
          },
        },
      ],
      /** Await only values that are thenable; catches mistaken awaits. */
      "@typescript-eslint/await-thenable": "error",
      /** Prefer `return await` in try/catch so rejections surface with correct stack. */
      "@typescript-eslint/return-await": ["error", "error-handling-correctness-only"],
      /** Exported functions/classes must declare return types (public API surface). */
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "max-len": [
        COMPLEXITY_WARN,
        {
          code: 110,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreComments: true,
        },
      ],
      complexity: [COMPLEXITY_WARN, 10],
      "max-depth": [COMPLEXITY_WARN, 4],
      "max-params": [COMPLEXITY_WARN, 5],
      "max-lines-per-function": [
        COMPLEXITY_WARN,
        {
          max: 110,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
    },
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: ["hooks/**", "index.ts", "scripts/**", "push/**", "**/*.test.{ts,tsx,js,jsx}"],
    rules: {
      /** Bun hook scripts and CLI root use top-level await by design — excluded via ignores above. */
      "no-restricted-syntax": [
        "error",
        {
          selector: "Program > ExpressionStatement > AwaitExpression",
          message:
            "Top-level await is not allowed; use async main() plus void main().catch(...) or an async IIFE.",
        },
        {
          selector:
            "Program > VariableDeclaration > VariableDeclarator[init.type='AwaitExpression']",
          message:
            "Top-level await is not allowed; use async main() plus void main().catch(...) or an async IIFE.",
        },
        {
          selector:
            "Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[init.type='AwaitExpression']",
          message:
            "Top-level await is not allowed; use async main() plus void main().catch(...) or an async IIFE.",
        },
        {
          selector: "Program > ExportDefaultDeclaration > AwaitExpression",
          message:
            "Top-level await is not allowed; use async main() plus void main().catch(...) or an async IIFE.",
        },
        {
          selector: "Program > ForOfStatement[await=true]",
          message:
            "Top-level for-await is not allowed; use async main() plus void main().catch(...) or an async IIFE.",
        },
      ],
    },
  },
  {
    files: ["**/*.tsx", "**/*.jsx"],
    rules: {
      "max-depth": [COMPLEXITY_WARN, 3],
      "max-lines-per-function": [
        COMPLEXITY_WARN,
        {
          max: 60,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
    },
  },
  {
    files: ["www/**/*.js"],
    rules: {
      /** Browser-only JS served via CDN importmap — no TypeScript project context. */
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/return-await": "off",
    },
  },
  {
    files: ["**/*.test.{ts,tsx,js,jsx}"],
    rules: {
      complexity: "off",
      "max-lines-per-function": "off",
      /** Bun `expect()` / matcher chains are not always typed as Thenable. */
      "@typescript-eslint/await-thenable": "off",
      /** Test helpers and specs are not the package API surface. */
      "@typescript-eslint/explicit-module-boundary-types": "off",
      /** `setTimeout(async () => …)` and similar patterns in tests. */
      "@typescript-eslint/no-misused-promises": "off",
    },
  }
)

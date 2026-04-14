import globals from "globals"
import tseslint from "typescript-eslint"

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
      /** No `any` — use concrete types or Zod-inferred types (`z.infer<typeof schema>`). */
      "@typescript-eslint/no-explicit-any": "error",
      /**
       * Ban the `unknown` type keyword (including inside `Record<string, unknown>`). **warn** so
       * `eslint`/`bun run lint` stay green during migration; tighten to `"error"` when the tree is clean.
       */
      "@typescript-eslint/no-restricted-types": [
        "warn",
        {
          types: {
            unknown: {
              message:
                " Validate with Zod at the boundary and use z.infer<typeof schema> or a concrete type instead of `unknown`.",
            },
          },
        },
      ],
      "max-len": [
        "warn",
        {
          code: 110,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreComments: true,
        },
      ],
      complexity: ["warn", 10],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 5],
      "max-lines-per-function": [
        "warn",
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
      "max-depth": ["warn", 3],
      "max-lines-per-function": [
        "warn",
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
    files: ["hooks/**/*.ts"],
    rules: {
      /** Every floating promise in a hook is a silent failure — no void escape hatch. */
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      /** Force `return await` everywhere so rejections always surface with correct stack. */
      "@typescript-eslint/return-await": ["error", "always"],
      /** Async functions without await are likely missing error handling. */
      "@typescript-eslint/require-await": "error",
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
  },
  {
    files: [
      "src/web/**",
      "hooks/**",
      "scripts/**",
      "src/SwizHook.ts",
      "src/claude-model-settings.ts",
      "src/codex-event-map.contract.test.ts",
      "src/gemini-event-map.contract.test.ts",
      "src/commands/**",
      "src/dispatch/**",
      "src/settings/**",
      "src/tasks/**",
      "src/utils/**",
      "src/*-analysis*.ts",
      "src/*-extract*.ts",
      "src/*-push-gate*.ts",
      "src/*-summary*.ts",
      "src/*-sessions-discovery*.ts",
      "src/issue-store*.ts",
      "src/plugins.ts",
      "src/pr-review-autosteer.ts",
      "src/swiz-hook-commands.ts",
      "src/tools.ts",
      "src/transcript-schemas.ts",
      "**/*.test.ts",
    ],
    rules: {
      /** Modules that handle loosely-typed JSON from network/dispatch or test files. */
      "@typescript-eslint/no-explicit-any": "off",
      /** Modules that parse untyped runtime data — Zod would be ideal but migration is incremental. */
      "@typescript-eslint/no-restricted-types": "off",
    },
  }
)

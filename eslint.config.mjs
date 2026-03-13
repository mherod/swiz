import globals from "globals"
import tseslint from "typescript-eslint"

const COMPLEXITY_WARN = "warn"

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".swiz/**",
      "coverage/**",
      "dist/**",
      "**/*.d.ts",
    ],
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
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
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
      complexity: [COMPLEXITY_WARN, 12],
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
    files: ["**/*.test.{ts,tsx,js,jsx}"],
    rules: {
      complexity: "off",
      "max-lines-per-function": "off",
    },
  }
)

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Determinism rules for the engine (spec section 4.1, decisions D-003 and D-005).
 * Only + − × ÷ and Math.sqrt may be used for engine arithmetic, plus exact operations.
 * Everything else comes from packages/engine/src/detmath.ts.
 */
const bannedMath = ["random", "exp", "expm1", "log", "log1p", "log2", "log10", "pow", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh", "cbrt", "hypot", "fround"].map(
  (property) => ({
    object: "Math",
    property,
    message: `Math.${property} is not deterministic across JS engines. Use packages/engine/src/detmath.ts (or rng.ts for randomness).`,
  }),
);

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "packages/schema/src/generated/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["tools/**/*.{js,mjs}", "*.config.{js,ts}", "apps/web/vite.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    // Engine purity (invariant 6) and determinism.
    files: ["packages/engine/src/**/*.ts"],
    rules: {
      "no-restricted-properties": ["error", ...bannedMath, { object: "Date", property: "now", message: "The engine has no clock; time comes from the simulation." }, { object: "performance", property: "now", message: "The engine has no clock; time comes from the simulation." }],
      "no-restricted-globals": [
        "error",
        ...["window", "document", "self", "globalThis", "navigator", "fetch", "XMLHttpRequest", "WebSocket", "localStorage", "sessionStorage", "postMessage", "setTimeout", "setInterval", "requestAnimationFrame", "performance", "process", "require", "crypto"].map((name) => ({
          name,
          message: `The engine must not use "${name}": it is pure and runs the same in a Worker and in Node.`,
        })),
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date']", message: "The engine has no clock." },
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: "Use rng.ts." },
      ],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*", "fs", "path", "os", "child_process", "worker_threads"], message: "The engine must not depend on Node." },
            { group: ["react", "react-dom", "pixi.js", "@bottleneck/web", "@bottleneck/web/*"], message: "The engine must not depend on the UI." },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);

# AGENTS.md

## Build, Lint, and Test Commands

- **Build:** `bun run build` (uses tsdown)
- **Dev:** `bun run dev`
- **Lint:** `bun run lint` (uses @echristian/eslint-config)
- **Lint & fix staged files:** `bunx lint-staged`
- **Test all:** `bun test`
- **Test single file:** `bun test tests/claude-request.test.ts`
- **Start (prod):** `bun run start`
- **Typecheck:** `bun run typecheck`
- **Unused code check:** `bun run knip`

## Code Style Guidelines

- **Imports:** ESNext syntax. Prefer absolute imports via `~/*` for `src/*` (see `tsconfig.json`).
- **Types:** Strict TypeScript (`strict: true`). Avoid `any`; use explicit types and interfaces.
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Error handling:** Use explicit error classes (see `src/lib/error.ts`). Avoid silent failures.
- **Unused:** Unused imports/variables are errors (`noUnusedLocals`, `noUnusedParameters`).
- **Switches:** No fallthrough in switch statements.
- **Modules:** ESNext modules, no CommonJS.
- **Testing:** Bun's built-in test runner. Place tests in `tests/`, name `*.test.ts`.
- **Linting:** `@echristian/eslint-config` covers stylistic, unused-imports, regex, and package.json rules.

## Scope

This project is a local bridge that exposes the GitHub Copilot API as
OpenAI- and Anthropic-compatible endpoints so tools like Claude Code can
target it. Keep it small: only `auth` and `start` CLI commands, no Docker,
no external dashboards.

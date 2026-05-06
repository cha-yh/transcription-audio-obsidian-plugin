# Repository Guidelines

## Project Structure & Module Organization

This repository is an Obsidian plugin for audio transcription. The plugin entry point is `main.ts`; the bundled runtime output is `main.js` and should be treated as generated. Core domain code lives under `_base/`: services in `_base/services`, constants in `_base/constants`, shared types in `_base/types`, utilities in `_base/utils`, and UI views in `_base/ui`. Workflow orchestration belongs in `controllers/`. Tests are colocated in `__tests__` folders, with shared helpers and Obsidian mocks in `tests/`. Project metadata and release files are `manifest.json`, `versions.json`, `styles.css`, and `docs/`.

## Build, Test, and Development Commands

Use Yarn 4 for package scripts.

- `yarn install`: install dependencies from `yarn.lock`.
- `yarn dev`: run esbuild in watch mode for local development.
- `yarn dev:test`: run watch mode with a test manifest suffix.
- `yarn build`: type-check with `tsc` and build the production bundle.
- `yarn test`: run Vitest in watch mode.
- `yarn test:coverage`: run Vitest once with coverage.
- `yarn version`: update `manifest.json` and `versions.json` during release prep.

For local Obsidian testing, set `OBSIDIAN_PLUGINS_PATH` in `.env.local`; optional `OBSIDIAN_PLUGIN_DIR`, `OBSIDIAN_TEST_ID_SUFFIX`, and `OBSIDIAN_TEST_NAME_SUFFIX` customize copied plugin output.

## Coding Style & Naming Conventions

Write TypeScript with ES module imports, double quotes, semicolons, and two-space indentation. Keep service classes named by responsibility, such as `TranscriptionService` or `AudioService`, and keep tests named `*.test.ts`. Prefer the `_base` path alias for shared modules where existing code does. Avoid editing generated `main.js`; change source files and rebuild.

## Testing Guidelines

Vitest runs in a Node environment with `obsidian` aliased to `tests/__mocks__/obsidian.ts`. Add or update tests beside the code being changed, for example `_base/services/audio/__tests__/AudioService.test.ts`. Use focused unit tests for service, controller, constants, and utility behavior. Run `yarn test` while developing and `yarn test:coverage` before larger changes.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`. Keep commit subjects imperative and scoped to one change. Pull requests should include a concise summary, test results, linked issues when applicable, and screenshots or short recordings for visible Obsidian UI changes such as settings or progress panel updates.

## Security & Configuration Tips

Do not commit `.env.local`, API keys, vault-specific paths, generated bundles, or coverage output. Prefer Obsidian SecretStorage for Gemini API keys, and keep README configuration notes in sync when changing settings or model defaults.

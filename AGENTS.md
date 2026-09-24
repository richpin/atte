Atte is a desktop app that provides a consistent UI across coding agents, built with Tauri 2, SolidJS, and Rust, targeting macOS first.

Use pnpm for SolidJS/TypeScript and Cargo for Rust.
Prefix commit messages with the appropriate Conventional Commit type (for example, `feat:`, `fix:`, `docs:`, or `chore:`).
Create or update README.md only when explicitly requested.
Keep code and documentation in sync.
Until the first release, keep the database at schema v1 by updating the initial schema directly, without upgrade migrations.
Write test fixtures and helper programs in the project's existing Rust or TypeScript stack, using its existing toolchain and dependencies.

Study how established products solve the problem before designing a solution. Adopt their proven patterns and conventions rather than inventing an approach from scratch.
Treat `docs/research` as temporary working material and keep it out of Git history.
Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
Keep components modular and concerns clearly separated.
Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

Use Feature-Sliced Design (FSD) for frontend organization and follow Cargo's standard package layout and crate conventions.

## Implementation references

- When implementing or reviewing Rust(backend) code, invoke the `rust-best-practices` skill.
- When implementing or reviewing SolidJS(frontend) code, refer to `docs/solid.md`.
- When implementing or reviewing Tauri-specific code, refer to `docs/tauri.md`.

## Agent skills

### Issue tracker

For specs and tickets, use the local Markdown tracker.
Read `docs/agents/issue-tracker.md` before tracker operations.

### Domain docs

This is a single-context project.
Before exploring the codebase, read `docs/agents/domain.md`.

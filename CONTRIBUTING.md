# Contributing to Toki

Thanks for your interest in improving Toki.

## Layout

- `core/` — Rust engine (napi-rs addon): `server.rs` (napi surface, route table,
  runtime), `http.rs` (HTTP/1.1 connection loop), `convert.rs` (JS-facing types).
- `ts/` — TypeScript source (compiled to `dist/`).
- `bindings/` — generated Node-API loader, types, and binary (rebuilt by `npm run build`; git-ignored).
- `__test__/` — tests (`node:test`). `examples/` — samples.

The native fast-path (`app.native.*`) is allocation-free and must stay that way —
keep new per-request work on the dynamic (JavaScript) path only.

## Setup

```bash
npm install
npm run build      # build:native (release) + build:ts
```

`npm run build:debug` is a faster, unoptimized native build for iteration.

## Before opening a PR

```bash
npm run lint       # cargo fmt --check, cargo clippy, tsc, prettier --check
npm test
```

- Rust: format with `cargo fmt`; keep `cargo clippy --lib` warning-free.
- TypeScript: `npm run format` (Prettier); the strict tsconfig must pass.
- Add or update tests for behavior changes.

## Naming

- Rust: `snake_case` items, `UpperCamelCase` types (RFC 430 / API Guidelines).
- TypeScript: `camelCase` values, `PascalCase` types.

## Releasing

Tag `vX.Y.Z`; the release workflow builds every platform binary and publishes the
platform packages plus the main package (needs the `NPM_TOKEN` secret).

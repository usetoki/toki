# Contributing to Toki

Thanks for your interest in improving Toki.

## Layout

- `src/` — Zig engine (Node-API addon). `main.zig` registers the exports;
  `engine.zig`/`loop.zig`/`stream.zig` are the connection state and hot path;
  `server.zig` wires listen/options; `parser.zig`/`router.zig`/`response.zig`/
  `static.zig`/`mime.zig`/`ratelimit.zig` are the request/response logic.
- `ts/` — TypeScript API (compiled to `dist/`). `app.ts` + `pipeline.ts` are the
  framework core; the rest is the public surface.
- `__test__/` — tests (`node:test`, run as `.ts`). `examples/` — runnable samples.

The native engine is allocation-free on the hot path and must stay that way. Keep
per-request work that touches V8 objects on the TypeScript side, where V8's own
fast paths beat crossing the N-API boundary. See the boundary rule in the README.

## Setup

```bash
npm install
npm run build      # build:native (ReleaseFast) + build:ts
```

`npm run build:debug` is a faster, unoptimized native build for iteration.

## Before opening a PR

```bash
npm run lint       # zig fmt --check, tsc, prettier --check
npm test           # zig build test + the Node test suite
```

- Zig: format with `zig fmt`; keep `zig build -Doptimize=ReleaseSafe` clean.
- TypeScript: `npm run format` (Prettier); the strict tsconfig must pass.
- Add or update tests for behavior changes. New native logic gets Zig unit tests;
  new framework behavior gets a `node:test` case.

## Naming

- Zig: `snake_case` functions and variables, `UpperCamelCase` types.
- TypeScript: `camelCase` values, `PascalCase` types.

## Releasing

Tag `vX.Y.Z`; the release workflow cross-compiles the addon for every platform
(Zig builds them all from one host) and publishes to npm (needs the `NPM_TOKEN`
secret).

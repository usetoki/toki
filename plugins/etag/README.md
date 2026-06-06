# @usetoki/toki-etag

Automatic `ETag` validators and `304 Not Modified` for dynamic
[toki](https://usetoki.github.io/toki/) responses. Static files are already validated
natively; this covers everything your handlers build.

```bash
npm install @usetoki/toki-etag
```

## Usage

```ts
import { createApp } from "@usetoki/toki";
import { etag } from "@usetoki/toki-etag";

const app = createApp();
etag(app);

app.get("/users/:id", (req) => db.user(req.params.id)); // now carries an ETag
```

Every GET/HEAD response gets an `ETag` derived from its body. When the client sends back
`If-None-Match` with that tag, toki answers `304 Not Modified` with an empty body — the
handler still runs, but the payload doesn't go over the wire.

## Options

- **`weak`** — emit a weak validator (`W/"…"`). Default `false`.
- **`algorithm`** — `"fnv1a"` (default) is a fast, non-crypto hash that's plenty for a
  cache validator; `"sha1"`, `"md5"`, and `"sha256"` use `node:crypto` if you'd rather.

A handler that sets its own `ETag` is left untouched, and streaming responses
(`reply.stream`) are skipped — they have no materialized body to hash.

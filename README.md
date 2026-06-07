# Giri

<img width="128" src="https://raw.githubusercontent.com/boon4681/giri/refs/heads/main/.image/logo.png" />

A stupid attempt from a stupid man who lack of foresight trying to make a backend framework.

## Why does giri exist?
Because I can, and I am too lazy to write an OpenAPI spec. Write handlers, return values. Giri infers the OpenAPI spec from the handlers, and generates types for params and `openapi.json` from them. Runs on Hono.

> Status: early and experimental. Hono is the only adapter today; the API will change.

## Install

```sh
yarn add giri hono @hono/node-server zod
```

`hono`, `@hono/node-server`, `zod`, `valibot`, and `typescript` are optional peers — install
only what you use.

## Quick start

```sh
npx giri init     # scaffold giri.config.ts + src/routes + tsconfig + .gitignore
npx giri sync     # generate .giri/ (manifest, param types, openapi.json)
npx giri serve    # sync, then run the dev server (watches src/ and re-syncs)
```

Then hit it:

```sh
curl http://localhost:3000/
```

## Config

`giri.config.ts` is declarative — it is loaded at build time, so keep it cheap and free of
side effects (no DB drivers here; see [Lifecycle](#lifecycle)).

```ts
import { defineConfig } from "giri";
import { hono } from "giri/adapters/hono";

export default defineConfig({
    adapter: hono(),                       // required: the backend bridge
    server: { port: 3000, hostname: "127.0.0.1" },
    outDir: ".giri",                       // where generated output lives
    alias: { "$db": "./src/db.ts" },       // import aliases, also written into tsconfig
});
```

## Routes

Every URL segment is a **folder**; every HTTP verb is its own file inside it.

```
src/routes/
  +get.ts                       -> GET    /
  +shared.ts                    -> folder config for everything below
  users/
    +get.ts                     -> GET    /users
    +post.ts                    -> POST   /users
    [id]/
      +get.ts                   -> GET    /users/:id
      posts/
        [postId]/
          +get.ts               -> GET    /users/:id/posts/:postId
  db.ts                         -> no '+' prefix = plain helper, ignored by the router
```

- `[id]` folder becomes the param `:id`; params nest down the path.
- Files without a `+` prefix are not routes — colocate helpers freely.

A verb file has one shape: the `handle` named export is the handler. Everything else is an
optional named export, so the trivial case is one line and complexity is additive.

```ts
// src/routes/users/[id]/+get.ts
import type { Handle } from "./$types";    // generated per folder; binds c.params to this path
import { findUser } from "../../../db";

export const handle: Handle = (c) => {
    const user = findUser(c.params.id);    // c.params.id is typed as string
    if (!user) return c.json({ message: "user not found" }, 404);
    return c.json(user);
};
// inferred responses: 200 -> User, 404 -> { message: string }
```

## The context `c`

Giri owns `c`, so the return type is the schema on every backend:

- `c.json(data, status?)` / `c.text(text, status?)` — return value carries the status in its type.
- `c.params` — typed from the folder path.
- `c.req.valid("body" | "query")` — parsed, typed input (see below).
- `c.req.header(name)`, `c.req.url`, etc.
- `c.get(key)` / `c.set(key, value)` — per-request vars from middleware.
- `c.app` — app-wide services from `src/main.ts` `init()` (see [Lifecycle](#lifecycle)).

## Inputs

Outputs are inferred; inputs are declared with a **wrapped** schema so giri gets both runtime
validation and a JSON Schema for the doc. Wrappers live in `giri/validators/zod` and
`giri/validators/valibot`.

```ts
// src/routes/users/+post.ts
import { z } from "zod";
import { zod } from "giri/validators/zod";
import type { POST } from "./$types";

export const body = zod.body({
    json: z.object({ name: z.string().min(1) }),
});
export const query = zod.query(z.object({ page: z.coerce.number().default(1) }));

export const handle: POST = (c) => {
    const { name } = c.req.valid("body");  // typed + validated
    return c.json({ name }, 201);
};
```

`zod.body` can map multiple content types (`json`, `form`) dispatched on `Content-Type` at
runtime. An unwrapped schema is rejected at build time.

## Middleware

Middleware use giri's `(c, next)` shape and live in two places:

- **Broad:** `export const middleware` in a folder's `+shared.ts` — applies to the whole subtree.
- **Precise:** `export const middleware` in a verb file — applies to that one verb.

Use `stack(...)` instead of a plain array so injected vars keep their types and propagate to
downstream handlers. Run order: inherited `+shared.ts` (root to leaf), then the verb's
`middleware`, then the handler.

```ts
// src/routes/+shared.ts
import { stack } from "giri";
import type { Middleware } from "./$types";

const requestId: Middleware<{ requestId: string }> = async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? "example-request");
    await next();
};

export const middleware = stack(requestId);
// every handler below now sees c.get("requestId"): string
```

Tag a middleware with `defineMiddleware` to feed OpenAPI security automatically — a route that
uses it shows the scheme, a public route does not.

```ts
// src/auth.ts
import { defineMiddleware } from "giri";

export const auth = defineMiddleware<{ userId: string }>(
    {
        openapi: {
            security: [{ bearerAuth: [] }],
            securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
        },
    },
    async (c, next) => {
        // verify a token, then c.set("userId", ...)
        await next();
    },
);
```

Hide a route or subtree from `openapi.json` with `export const openapi = false` (in a verb file
or a `+shared.ts`). Hidden routes still serve normally.

## Lifecycle

`src/main.ts` is the optional home for imperative startup — opening pools, validating env,
graceful shutdown. Giri owns the serve and calls these hooks; the adapter still binds the port.

```ts
// src/main.ts
import type { Services } from "giri";

export const init = () => {
    // leave init unannotated — its return type is the source of truth for c.app
    return { db: connectDb(process.env.DATABASE_URL) };
};

export const teardown = (services: Services) => {
    return services.db.close();            // runs on SIGINT / SIGTERM
};
```

Flow: load `main.ts` -> `await init()` -> hold services -> adapter serves -> `teardown` on
exit. `init` runs once and is not re-run on watch rebuilds. The returned object reaches every
handler as a typed `c.app`, inferred from `init`'s return — no declaration needed.

## CLI

| Command | What it does |
| --- | --- |
| `giri init` | Scaffold `giri.config.ts`, a starter route, tsconfig paths, and `.gitignore`. |
| `giri sync` | Scan `src/routes` and regenerate `.giri/` (manifest, param types, `openapi.json`). |
| `giri serve` | `sync`, run `init()`, then serve via the adapter. Watches `src/` and re-syncs. |
| `giri build` | Planned — currently a no-op. |

`giri serve` flags: `--port <n>`, `--host <addr>`, `--no-watch`.

## Generated output (`.giri/`)

Everything derived lives in `.giri/` at the project root: param `.d.ts` per route, the route
manifest, and the assembled `openapi.json`. It is gitignored and rebuilt on demand — never edit
it, only import from it.

## Example

See [`example/`](example) for a runnable Hono app:

```sh
cd example
yarn install
yarn sync
yarn dev
```

## License

MIT
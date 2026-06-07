# Giri Example

This is a tiny Hono-backed giri app using file routes under `src/routes`.

From this directory:

```sh
yarn install
yarn sync
yarn typecheck
yarn test
yarn dev
```

The repository checkout can also run the example against local source with:

```sh
node ../dist/cli.js sync
../node_modules/.bin/vitest --run demo.test.ts
```

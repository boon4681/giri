import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { hono } from '../src/adapters/hono';
import {
    createApp,
    defineBodySchema,
    defineInputSchema,
    defineMiddleware,
    stack,
    type GiriAdapter,
    type GiriRouteRegistration,
    type GiriRuntimeRoute,
} from '../src/runtime';

const tmp = join(process.cwd(), 'test', '.tmp', 'runtime');

interface TestApp {
    registrations: GiriRouteRegistration[];
}

function testAdapter(): GiriAdapter<TestApp> {
    return {
        name: 'test',
        createApp: () => ({ registrations: [] }),
        register: (app, route) => {
            app.registrations.push(route);
        },
        fetch: async () => new Response('not implemented', { status: 501 }),
        serve: () => ({ close() {} }),
    };
}

describe('createApp', () => {
    beforeEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    it('constructs and returns a native Hono app', async () => {
        const app = createApp({
            adapter: hono(),
            services: { source: 'playground' },
            routes: [
                {
                    method: 'GET',
                    path: '/users/:id',
                    module: {
                        handle: (c) => c.json({
                            id: c.params.id,
                            source: c.app.source,
                        }),
                    },
                },
            ],
        });

        const response = await app.fetch(new Request('https://giri.test/users/42'));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            id: '42',
            source: 'playground',
        });
    });

    it('returns the adapter app and delegates every route registration', () => {
        const adapter = testAdapter();
        const routes: GiriRuntimeRoute[] = [
            {
                method: 'GET',
                path: '/users/:id',
                module: {
                    handle: (c) => c.json({ id: c.params.id }),
                },
            },
            {
                method: 'POST',
                path: '/users',
                module: {
                    handle: (c) => c.json({ created: true }, 201),
                },
            },
        ];

        const app = createApp({ adapter, routes });

        expect(app.registrations).toHaveLength(2);
        expect(app.registrations.map(({ method, path }) => `${method} ${path}`)).toEqual([
            'GET /users/:id',
            'POST /users',
        ]);
        expect(app.registrations[0].handle).toBe(routes[0].module.handle);
    });

    it('combines inherited and route middleware and passes services and input to the adapter', () => {
        const shared = defineMiddleware(async (_c, next) => next());
        const own = defineMiddleware(async (_c, next) => next());
        const query = defineInputSchema<{ page: number }>({
            validate: () => ({ ok: true, value: { page: 1 } }),
            toJsonSchema: () => ({ type: 'object' }),
        });
        const services = { db: 'browser-db' };
        const app = createApp({
            adapter: testAdapter(),
            services,
            cookieSecret: 'secret',
            routes: [
                {
                    method: 'GET',
                    path: '/search',
                    shared: [{ middleware: stack(shared) }],
                    module: {
                        middleware: stack(own),
                        query,
                        handle: (c) => c.json(c.req.valid('query')),
                    },
                },
            ],
        });

        expect(app.registrations[0]).toMatchObject({
            method: 'GET',
            path: '/search',
            middleware: [shared, own],
            services,
            cookieSecret: 'secret',
            input: { query: [query] },
        });
    });

    it('validates middleware-owned body and query input before middleware and exposes it downstream', async () => {
        const query = defineInputSchema<{ page: number }>({
            validate: (value) => {
                const page = Number((value as { page?: string }).page);
                return Number.isInteger(page) && page > 0
                    ? { ok: true, value: { page } }
                    : { ok: false, issues: { page: 'must be a positive integer' } };
            },
            toJsonSchema: () => ({
                type: 'object',
                properties: { page: { type: 'integer', minimum: 1 } },
                required: ['page'],
            }),
        });
        const json = defineInputSchema<{ term: string }>({
            validate: (value) =>
                typeof (value as { term?: unknown }).term === 'string'
                    ? { ok: true, value: value as { term: string } }
                    : { ok: false, issues: { term: 'must be a string' } },
            toJsonSchema: () => ({
                type: 'object',
                properties: { term: { type: 'string' } },
                required: ['term'],
            }),
        });
        const body = defineBodySchema({ json });
        let middlewarePage: number | undefined;
        let middlewareTerm: string | undefined;
        const pagination = defineMiddleware({ body, query }, async (c, next) => {
            middlewarePage = c.req.valid('query').page;
            middlewareTerm = c.req.valid('body').term;
            await next();
        });
        const app = createApp({
            adapter: hono(),
            routes: [
                {
                    method: 'POST',
                    path: '/search',
                    shared: [{ middleware: pagination }],
                    module: {
                        handle: (c) => c.json({
                            ...c.req.valid('query'),
                            ...c.req.valid('body'),
                        }),
                    },
                },
            ],
        });

        const valid = await app.fetch(new Request('https://giri.test/search?page=2', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ term: 'giri' }),
        }));
        expect(valid.status).toBe(200);
        expect(middlewarePage).toBe(2);
        expect(middlewareTerm).toBe('giri');
        await expect(valid.json()).resolves.toEqual({ page: 2, term: 'giri' });

        const invalid = await app.fetch(new Request('https://giri.test/search?page=0', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ term: 'giri' }),
        }));
        expect(invalid.status).toBe(400);
        expect(middlewarePage).toBe(2);
    });

    it('collects every owner of a target so their validators merge (middleware first, route last)', () => {
        const middlewareQuery = defineInputSchema({
            validate: (value) => ({ ok: true as const, value }),
            toJsonSchema: () => ({ type: 'object' }),
        });
        const routeQuery = defineInputSchema({
            validate: (value) => ({ ok: true as const, value }),
            toJsonSchema: () => ({ type: 'object' }),
        });
        const pagination = defineMiddleware({ query: middlewareQuery }, async (_c, next) => next());

        const app = createApp({
            adapter: testAdapter(),
            routes: [
                {
                    method: 'GET',
                    path: '/search',
                    shared: [{ middleware: pagination }],
                    module: {
                        query: routeQuery,
                        handle: (c) => c.json({ ok: true }),
                    },
                },
            ],
        });

        expect(app.registrations[0].input).toEqual({ query: [middlewareQuery, routeQuery] });
    });

    it('respects skipInherited while retaining route middleware', () => {
        const inherited = defineMiddleware(async (_c, next) => next());
        const own = defineMiddleware(async (_c, next) => next());
        const app = createApp({
            adapter: testAdapter(),
            routes: [
                {
                    method: 'GET',
                    path: '/',
                    shared: [{ middleware: inherited }],
                    module: {
                        config: { skipInherited: true },
                        middleware: own,
                        handle: (c) => c.text('ok'),
                    },
                },
            ],
        });

        expect(app.registrations[0].middleware).toEqual([own]);
    });

    it('leaves routing and request dispatch entirely to the adapter', () => {
        const calls: string[] = [];
        const adapter: GiriAdapter<{ framework: string }> = {
            createApp: () => ({ framework: 'native-app' }),
            register: (_app, route) => {
                calls.push(`${route.method} ${route.path}`);
            },
            fetch: async () => new Response('framework-owned'),
            serve: () => ({ close() {} }),
        };

        const app = createApp({
            adapter,
            routes: [
                {
                    method: 'GET',
                    path: '/framework-owned',
                    module: { handle: (c) => c.text('unused by core') },
                },
            ],
        });

        expect(app).toEqual({ framework: 'native-app' });
        expect(calls).toEqual(['GET /framework-owned']);
        expect(app).not.toHaveProperty('fetch');
        expect(app).not.toHaveProperty('match');
    });

    it('rejects malformed and duplicate route registrations before handing them off', () => {
        const handedOff: GiriRouteRegistration[] = [];
        const duplicateAdapter: GiriAdapter<TestApp> = {
            createApp: () => ({ registrations: [] }),
            register: (_app, route) => handedOff.push(route),
            fetch: async () => new Response('not implemented', { status: 501 }),
            serve: () => ({ close() {} }),
        };
        expect(() => createApp({
            adapter: duplicateAdapter,
            routes: [
                {
                    method: 'GET',
                    path: '/',
                    module: { handle: (c) => c.text('first') },
                },
                {
                    method: 'GET',
                    path: '/',
                    module: { handle: (c) => c.text('second') },
                },
            ],
        })).toThrow(/Duplicate Giri runtime route/);
        expect(handedOff).toEqual([]);

        expect(() => createApp({
            adapter: testAdapter(),
            routes: [
                {
                    method: 'GET',
                    path: 'missing-slash',
                    module: { handle: (c) => c.text('nope') },
                },
            ],
        })).toThrow(/must start with/);
    });

    it('bundles with a caller-supplied browser GiriAdapter without Node.js built-ins', async () => {
        await mkdir(tmp, { recursive: true });
        const entry = join(tmp, 'entry.ts');
        const runtimePath = relative(tmp, join(process.cwd(), 'src', 'runtime'))
            .replace(/\\/g, '/');
        const runtimeImport = runtimePath.startsWith('.') ? runtimePath : `./${runtimePath}`;
        await writeFile(
            entry,
            [
                `import { createApp } from ${JSON.stringify(runtimeImport)};`,
                'const adapter = {',
                '  createApp: () => ({ routes: [] }),',
                '  register: (app, route) => app.routes.push(route),',
                '  fetch: async () => new Response("browser"),',
                '  serve: () => ({ close() {} }),',
                '};',
                'export const app = createApp({',
                '  adapter,',
                '  routes: [{',
                '    method: "GET",',
                '    path: "/",',
                '    module: { handle: (c) => c.json({ ok: true }) },',
                '  }],',
                '});',
            ].join('\n'),
        );

        const result = await build({
            entryPoints: [entry],
            bundle: true,
            format: 'esm',
            platform: 'browser',
            target: 'es2022',
            write: false,
            logLevel: 'silent',
        });
        const output = result.outputFiles[0].text;

        expect(output).toContain('function createApp');
        expect(output).not.toMatch(/node:/);
        expect(output).not.toMatch(/\brequire\(/);
        expect(output).not.toMatch(/\bprocess\./);
    });
});

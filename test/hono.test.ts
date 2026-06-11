import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { buildGiriApp, defineConfig } from '../src';
import { fromHono, hono } from '../src/adapters/hono';

const tmp = join(process.cwd(), 'test', '.tmp', 'hono');

describe('hono adapter', () => {
    beforeEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    it('serves file routes through the portable giri context', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        await mkdir(join(routesDir, 'users', '[id]'), { recursive: true });
        await writeFile(
            join(routesDir, '+shared.ts'),
            'export const middleware = async (c, next) => { c.set("root", "yes"); await next(); };',
        );
        await writeFile(
            join(routesDir, 'users', '[id]', '+shared.ts'),
            'export const middleware = [async (c, next) => { c.set("leaf", "yes"); await next(); }];',
        );
        await writeFile(
            join(routesDir, 'users', '[id]', '+get.ts'),
            [
                'export const middleware = async (c, next) => { c.set("verb", "yes"); await next(); };',
                'export const handle = (c) => c.json({',
                '  id: c.params.id,',
                '  root: c.get("root"),',
                '  leaf: c.get("leaf"),',
                '  verb: c.get("verb"),',
                '});',
            ].join('\n'),
        );

        const config = defineConfig({
            adapter: hono(),
            outDir: join(tmp, '.giri'),
        });
        const built = await buildGiriApp(config, { cwd: tmp });

        const response = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/users/42'),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            id: '42',
            root: 'yes',
            leaf: 'yes',
            verb: 'yes',
        });
    });

    it('loads lazy route modules once on their first request', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const counterKey = '__giri_lazy_route_loads__';
        const state = globalThis as typeof globalThis & Record<string, number | undefined>;
        delete state[counterKey];
        await mkdir(routesDir, { recursive: true });
        await writeFile(
            join(routesDir, '+get.js'),
            [
                `const key = ${JSON.stringify(counterKey)};`,
                'const state = globalThis;',
                'state[key] = (state[key] ?? 0) + 1;',
                'exports.handle = (c) => c.json({ loads: state[key] });',
            ].join('\n'),
        );

        const config = defineConfig({ adapter: hono(), outDir: join(tmp, '.giri') });
        try {
            const built = await buildGiriApp(config, {
                cwd: tmp,
                lazy: true,
                loaderRegistered: true,
                aliasResolverRegistered: true,
            });
            expect(state[counterKey]).toBeUndefined();

            const first = await config.adapter.fetch(built.app, new Request('http://giri.test/'));
            expect(await first.json()).toEqual({ loads: 1 });
            expect(state[counterKey]).toBe(1);

            const second = await config.adapter.fetch(built.app, new Request('http://giri.test/'));
            expect(await second.json()).toEqual({ loads: 1 });
            expect(state[counterKey]).toBe(1);
        } finally {
            delete state[counterKey];
        }
    });

    it('seeds init() services into c.app for every route', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        await mkdir(routesDir, { recursive: true });
        await writeFile(
            join(routesDir, '+get.ts'),
            'export const handle = (c) => c.json({ name: c.app.db.name });',
        );

        const config = defineConfig({ adapter: hono(), outDir: join(tmp, '.giri') });
        const services = { db: { name: 'primary' } };
        const built = await buildGiriApp(config, { cwd: tmp, services });

        const response = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/'),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ name: 'primary' });
    });

    it('validates body exports and exposes c.req.valid("body")', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        await mkdir(join(routesDir, 'users'), { recursive: true });
        await writeFile(
            join(routesDir, 'users', '+post.ts'),
            [
                'const json = {',
                '  [Symbol.for("giri.input-schema")]: true,',
                '  validate(value) {',
                '    return typeof value?.name === "string"',
                '      ? { ok: true, value: { name: value.name.trim() } }',
                '      : { ok: false, issues: [{ path: ["name"] }] };',
                '  },',
                '  toJsonSchema() {',
                '    return { type: "object", properties: { name: { type: "string" } }, required: ["name"] };',
                '  },',
                '};',
                'export const body = { [Symbol.for("giri.body-schema")]: true, contents: { json } };',
                'export const handle = (c) => c.json({ name: c.req.valid("body").name }, 201);',
            ].join('\n'),
        );

        const config = defineConfig({ adapter: hono() });
        const built = await buildGiriApp(config, { cwd: tmp });

        const ok = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/users', {
                method: 'POST',
                body: JSON.stringify({ name: ' Ada ' }),
            }),
        );
        expect(ok.status).toBe(201);
        await expect(ok.json()).resolves.toEqual({ name: 'Ada' });

        const bad = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/users', {
                method: 'POST',
                body: JSON.stringify({}),
            }),
        );
        expect(bad.status).toBe(400);
    });

    it('accepts a JSON or multipart body and dispatches on Content-Type', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        await mkdir(join(routesDir, 'users'), { recursive: true });
        await writeFile(
            join(routesDir, 'users', '+post.ts'),
            [
                'const json = {',
                '  [Symbol.for("giri.input-schema")]: true,',
                '  validate: (v) => (typeof v?.name === "string"',
                '    ? { ok: true, value: { name: v.name } }',
                '    : { ok: false, issues: [{ path: ["name"] }] }),',
                '  toJsonSchema: () => ({ type: "object", properties: { name: { type: "string" } } }),',
                '};',
                'const form = {',
                '  [Symbol.for("giri.input-schema")]: true,',
                '  validate: (v) => (typeof v?.name === "string" && typeof v?.avatar === "string"',
                '    ? { ok: true, value: { name: v.name, avatar: v.avatar } }',
                '    : { ok: false, issues: [{ path: ["avatar"] }] }),',
                '  toJsonSchema: () => ({ type: "object", properties: { name: { type: "string" }, avatar: { type: "string" } } }),',
                '};',
                'export const body = { [Symbol.for("giri.body-schema")]: true, contents: { json, form } };',
                'export const handle = (c) => c.json(c.req.valid("body"));',
            ].join('\n'),
        );

        const config = defineConfig({ adapter: hono() });
        const built = await buildGiriApp(config, { cwd: tmp });

        const fromJson = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Ada' }),
            }),
        );
        expect(fromJson.status).toBe(200);
        await expect(fromJson.json()).resolves.toEqual({ type: 'json', data: { name: 'Ada' } });

        const form = new FormData();
        form.set('name', 'Ada');
        form.set('avatar', 'pic.png');
        const fromForm = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/users', { method: 'POST', body: form }),
        );
        expect(fromForm.status).toBe(200);
        await expect(fromForm.json()).resolves.toEqual({
            type: 'form',
            data: { name: 'Ada', avatar: 'pic.png' },
        });

        const invalid = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            }),
        );
        expect(invalid.status).toBe(400);
    });

    it('validates a real zod.body() over fetch (JSON + multipart)', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        await mkdir(join(routesDir, 'users'), { recursive: true });
        // Import the actual zod adapter by absolute source path (a tmp route can't resolve the
        // bare "@boon4681/giri/validators/zod" specifier), so this drives the real `zod.body()`.
        const zodAdapter = join(process.cwd(), 'src', 'validators', 'zod').replace(/\\/g, '/');
        await writeFile(
            join(routesDir, 'users', '+post.ts'),
            [
                'import { z } from "zod";',
                `import { zod } from "${zodAdapter}";`,
                '',
                'export const body = zod.body({',
                '  json: z.object({ name: z.string().min(1) }),',
                '  form: z.object({ name: z.string().min(1), avatar: z.string() }),',
                '});',
                '',
                'export const handle = (c) => c.json(c.req.valid("body"));',
            ].join('\n'),
        );

        const config = defineConfig({ adapter: hono() });
        const built = await buildGiriApp(config, { cwd: tmp });

        const fromJson = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Ada' }),
            }),
        );
        expect(fromJson.status).toBe(200);
        await expect(fromJson.json()).resolves.toEqual({ type: 'json', data: { name: 'Ada' } });

        const form = new FormData();
        form.set('name', 'Ada');
        form.set('avatar', 'pic.png');
        const fromForm = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/users', { method: 'POST', body: form }),
        );
        expect(fromForm.status).toBe(200);
        await expect(fromForm.json()).resolves.toEqual({
            type: 'form',
            data: { name: 'Ada', avatar: 'pic.png' },
        });

        // zod's own validation (min length) rejects through the same pipeline.
        const invalid = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: '' }),
            }),
        );
        expect(invalid.status).toBe(400);
    });

    it('resolves route imports through aliases from config', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        await mkdir(join(routesDir, 'status'), { recursive: true });
        await writeFile(
            join(tmp, 'src', 'lib.ts'),
            'export const status = "aliased";',
        );
        await writeFile(
            join(routesDir, 'status', '+get.ts'),
            [
                'import { status } from "@/lib";',
                '',
                'export const handle = (c) => c.json({ status });',
            ].join('\n'),
        );

        const config = defineConfig({
            adapter: hono(),
            alias: {
                '@/*': 'src/*',
            },
        });
        const built = await buildGiriApp(config, { cwd: tmp });

        const response = await config.adapter.fetch(
            built.app,
            new Request('http://giri.test/status'),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'aliased' });
    });

    it('bridges a native Hono middleware via fromHono (var injection + early return)', async () => {
        const adapter = hono();
        const app = adapter.createApp();

        // A real Hono middleware: redirect before the handler when ?deny=1, otherwise inject a var.
        const googleAuthLike: MiddlewareHandler = async (c, next) => {
            if (c.req.query('deny') === '1') {
                return c.redirect('https://login.example/start', 302);
            }
            c.set('user-google', { email: 'ada@giri.test' });
            await next();
        };

        adapter.register(app, {
            method: 'GET',
            path: '/me',
            middleware: [fromHono(googleAuthLike)],
            // The downstream giri handler reads the var the Hono middleware set, via c.get.
            handle: (c) => c.json({ user: c.get('user-google') }),
        });

        const ok = await adapter.fetch(app, new Request('http://giri.test/me'));
        expect(ok.status).toBe(200);
        await expect(ok.json()).resolves.toEqual({ user: { email: 'ada@giri.test' } });

        const redirected = await adapter.fetch(app, new Request('http://giri.test/me?deny=1'));
        expect(redirected.status).toBe(302);
        expect(redirected.headers.get('location')).toBe('https://login.example/start');
    });

    it('reads, sets, and signs cookies through Hono\'s native cookie helpers', async () => {
        const adapter = hono();
        const app = adapter.createApp();

        adapter.register(app, {
            method: 'GET',
            path: '/echo',
            middleware: [],
            handle: (c) => {
                c.cookie('seen', c.req.cookie('sid') ?? 'none', { path: '/', httpOnly: true });
                return c.json({ all: c.req.cookies() });
            },
        });
        adapter.register(app, {
            method: 'GET',
            path: '/sign',
            middleware: [],
            cookieSecret: 'topsecret',
            handle: async (c) => {
                await c.signedCookie('token', 'abc');
                return c.json({ ok: true });
            },
        });
        adapter.register(app, {
            method: 'GET',
            path: '/verify',
            middleware: [],
            cookieSecret: 'topsecret',
            handle: async (c) => c.json({ token: await c.req.signedCookie('token') }),
        });
        // Signs with a different secret: the signature is well-formed but won't verify.
        adapter.register(app, {
            method: 'GET',
            path: '/sign-wrong',
            middleware: [],
            cookieSecret: 'other-secret',
            handle: async (c) => {
                await c.signedCookie('token', 'abc');
                return c.json({ ok: true });
            },
        });

        const echo = await adapter.fetch(
            app,
            new Request('http://giri.test/echo', { headers: { cookie: 'sid=42; lang=th' } }),
        );
        expect(echo.status).toBe(200);
        await expect(echo.json()).resolves.toEqual({ all: { sid: '42', lang: 'th' } });
        const setCookie = echo.headers.getSetCookie();
        expect(setCookie).toHaveLength(1);
        expect(setCookie[0]).toContain('seen=42');
        expect(setCookie[0]).toContain('HttpOnly');

        // The signed cookie Hono writes verifies through Hono's own getSignedCookie on the way back.
        const signed = await adapter.fetch(app, new Request('http://giri.test/sign'));
        const pair = signed.headers.getSetCookie()[0].split(';')[0];
        const verified = await adapter.fetch(
            app,
            new Request('http://giri.test/verify', { headers: { cookie: pair } }),
        );
        await expect(verified.json()).resolves.toEqual({ token: 'abc' });

        const wrong = await adapter.fetch(app, new Request('http://giri.test/sign-wrong'));
        const wrongPair = wrong.headers.getSetCookie()[0].split(';')[0];
        const tampered = await adapter.fetch(
            app,
            new Request('http://giri.test/verify', { headers: { cookie: wrongPair } }),
        );
        await expect(tampered.json()).resolves.toEqual({ token: false });
    });

    it('catches a throwing middleware/handler and returns 500 (logging the route)', async () => {
        const adapter = hono();
        const app = adapter.createApp();

        adapter.register(app, {
            method: 'GET',
            path: '/boom',
            middleware: [
                async () => {
                    throw new Error('kaboom from middleware');
                },
            ],
            handle: (c) => c.json({ ok: true }),
        });
        adapter.register(app, {
            method: 'GET',
            path: '/handler-boom',
            middleware: [],
            handle: () => {
                throw new Error('kaboom from handler');
            },
        });

        const errors: unknown[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => errors.push(args);
        try {
            const mw = await adapter.fetch(app, new Request('http://giri.test/boom'));
            expect(mw.status).toBe(500);

            const handler = await adapter.fetch(app, new Request('http://giri.test/handler-boom'));
            expect(handler.status).toBe(500);
        } finally {
            console.error = original;
        }

        // The full stack (not just the message) is logged so the user can locate the throw.
        expect(errors.some((args) => String(args).includes('kaboom from middleware'))).toBe(true);
    });

    it('fromHono throws off the Hono adapter (no native context)', async () => {
        const bridged = fromHono(async (_c, next) => {
            await next();
        });
        const fakeGiriContext = {
            get: () => undefined,
            set: () => undefined,
        } as never;

        await expect(bridged(fakeGiriContext, async () => undefined)).rejects.toThrow(
            /only run on the Hono adapter/,
        );
    });

    it('supports hono-style context methods: html, redirect, body, notFound, header, status', async () => {
        const adapter = hono();
        const app = adapter.createApp();

        adapter.register(app, {
            method: 'GET',
            path: '/html',
            middleware: [],
            handle: (c) => c.html('<h1>hi</h1>'),
        });
        adapter.register(app, {
            method: 'GET',
            path: '/go',
            middleware: [],
            handle: (c) => c.redirect('/login'),
        });
        adapter.register(app, {
            method: 'GET',
            path: '/raw',
            middleware: [],
            handle: (c) => c.body('bytes', 201, { 'content-type': 'application/octet-stream' }),
        });
        adapter.register(app, {
            method: 'GET',
            path: '/missing',
            middleware: [],
            handle: (c) => c.notFound(),
        });
        // c.header set in middleware must land on the handler's json response.
        adapter.register(app, {
            method: 'GET',
            path: '/headed',
            middleware: [
                async (c, next) => {
                    c.header('x-powered-by', 'giri');
                    await next();
                },
            ],
            handle: (c) => c.json({ ok: true }),
        });
        // c.status sets the default status used by text() when no status arg is given.
        adapter.register(app, {
            method: 'GET',
            path: '/teapot',
            middleware: [],
            handle: (c) => {
                c.status(418);
                return c.text('teapot');
            },
        });

        const html = await adapter.fetch(app, new Request('http://giri.test/html'));
        expect(html.status).toBe(200);
        expect(html.headers.get('content-type')).toContain('text/html');
        await expect(html.text()).resolves.toBe('<h1>hi</h1>');

        const go = await adapter.fetch(app, new Request('http://giri.test/go'));
        expect(go.status).toBe(302);
        expect(go.headers.get('location')).toBe('/login');

        const raw = await adapter.fetch(app, new Request('http://giri.test/raw'));
        expect(raw.status).toBe(201);
        expect(raw.headers.get('content-type')).toBe('application/octet-stream');
        await expect(raw.text()).resolves.toBe('bytes');

        const missing = await adapter.fetch(app, new Request('http://giri.test/missing'));
        expect(missing.status).toBe(404);

        const headed = await adapter.fetch(app, new Request('http://giri.test/headed'));
        expect(headed.headers.get('x-powered-by')).toBe('giri');
        await expect(headed.json()).resolves.toEqual({ ok: true });

        const teapot = await adapter.fetch(app, new Request('http://giri.test/teapot'));
        expect(teapot.status).toBe(418);
        await expect(teapot.text()).resolves.toBe('teapot');
    });
});

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
});

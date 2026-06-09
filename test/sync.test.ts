import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { syncProject } from '../src';

const tmp = join(process.cwd(), 'test', '.tmp', 'sync');

describe('syncProject', () => {
    beforeEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    it('emits a manifest and param types per route folder', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'users', '[id]'), { recursive: true });
        await writeFile(join(routesDir, '+get.ts'), 'export const handle = () => new Response();');
        await writeFile(join(routesDir, 'users', '[id]', '+get.ts'), 'export const handle = () => new Response();');

        const result = await syncProject({
            alias: {
                '@/*': ['src/*'],
                '@db': 'src/db.ts',
            },
            outDir,
        }, { cwd: tmp });

        expect(result.routes).toHaveLength(2);
        await expect(readFile(join(outDir, 'manifest.json'), 'utf8')).resolves.toContain('/users/:id');

        const types = await readFile(
            join(outDir, 'types', 'src', 'routes', 'users', '[id]', '$types.d.ts'),
            'utf8',
        );
        expect(types).toContain('"id": string;');
        expect(types).toContain('export type Handle<Input');
        expect(types).toContain('import("@boon4681/giri").Handle<Params, Input, Vars>');
        expect(types).toContain('export type Middleware<Injects');

        const tsconfig = await readFile(join(outDir, 'tsconfig.json'), 'utf8');
        expect(tsconfig).toContain('"rootDirs"');
        expect(tsconfig).toContain('".."');
        expect(tsconfig).toContain('"./types"');
        expect(tsconfig).toContain('"include"');
        expect(tsconfig).toContain('"../src"');
        expect(tsconfig).toContain('"../giri.config.ts"');
        expect(tsconfig).toContain('"$giri/*"');
        expect(tsconfig).toContain('"./*"');
        expect(tsconfig).toContain('"@/*"');
        expect(tsconfig).toContain('"../src/*"');
        expect(tsconfig).toContain('"@db"');
        expect(tsconfig).toContain('"../src/db.ts"');
        expect(tsconfig).toContain('"@boon4681/giri/tsc"');
    });

    it('generates params that TypeScript can use to reject wrong keys', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'users', '[id]'), { recursive: true });
        await writeFile(
            join(routesDir, 'users', '[id]', '+get.ts'),
            [
                'import type { Handle } from "./$types";',
                '',
                'export const ok: Handle = (c) => c.json({ id: c.params.id });',
                '// @ts-expect-error missing is not a generated route param',
                'export const bad: Handle = (c) => c.json({ missing: c.params.missing });',
                '',
            ].join('\n'),
        );
        await syncProject({ outDir }, { cwd: tmp });

        const program = ts.createProgram([join(routesDir, 'users', '[id]', '+get.ts')], {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true,
            skipLibCheck: true,
            rootDirs: [routesDir, join(outDir, 'types', 'src', 'routes')],
            baseUrl: process.cwd(),
            paths: {
                '@boon4681/giri': ['src/index.ts'],
            },
            types: ['node'],
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        expect(diagnostics.map((diagnostic) => diagnostic.messageText)).toEqual([]);
    });

    it('infers the body from a verb file (single direct, multi discriminated) via the method handle', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'users'), { recursive: true });
        await writeFile(
            join(routesDir, 'users', '+post.ts'),
            [
                'import { z } from "zod";',
                'import { zod } from "@boon4681/giri/validators/zod";',
                'import type { POST } from "./$types";',
                '',
                'export const body = zod.body({',
                '  json: z.object({ name: z.string() }),',
                '  form: z.object({ name: z.string(), avatar: z.string() }),',
                '});',
                '',
                'export const handle: POST = (c) => {',
                '  const b = c.req.valid("body");',
                '  // discriminated union: narrow on the content-type tag',
                '  if (b.type === "form") return c.json({ avatar: b.data.avatar });',
                '  // @ts-expect-error avatar is only on the form branch',
                '  return c.json({ avatar: b.data.avatar });',
                '};',
            ].join('\n'),
        );
        await syncProject({ outDir }, { cwd: tmp });

        const program = ts.createProgram([join(routesDir, 'users', '+post.ts')], {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true,
            skipLibCheck: true,
            rootDirs: [routesDir, join(outDir, 'types', 'src', 'routes')],
            baseUrl: process.cwd(),
            paths: {
                '@boon4681/giri': ['src/index.ts'],
                '@boon4681/giri/validators/zod': ['src/validators/zod.ts'],
            },
            types: ['node'],
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        expect(diagnostics.map((diagnostic) => diagnostic.messageText)).toEqual([]);
    });

    it("folds a verb file's own middleware vars into its method handle c.get", async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'users'), { recursive: true });
        await writeFile(
            join(routesDir, 'users', '+post.ts'),
            [
                'import { stack } from "@boon4681/giri";',
                'import type { POST, Middleware } from "./$types";',
                '',
                'const auth: Middleware<{ userId: string }> = async (c, next) => {',
                '  await next();',
                '};',
                'export const middleware = stack(auth);',
                '',
                'export const handle: POST = (c) => {',
                '  const userId: string = c.get("userId");',
                '  // @ts-expect-error userId is a string, not a number',
                '  const bad: number = c.get("userId");',
                '  return c.json({ userId, bad });',
                '};',
            ].join('\n'),
        );
        await syncProject({ outDir }, { cwd: tmp });

        const program = ts.createProgram([join(routesDir, 'users', '+post.ts')], {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true,
            skipLibCheck: true,
            rootDirs: [routesDir, join(outDir, 'types', 'src', 'routes')],
            baseUrl: process.cwd(),
            paths: { '@boon4681/giri': ['src/index.ts'] },
            types: ['node'],
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        expect(diagnostics.map((diagnostic) => diagnostic.messageText)).toEqual([]);
    });

    it('types c.get from a fromHono() middleware Vars generic', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'me'), { recursive: true });
        await writeFile(
            join(routesDir, 'me', '+shared.ts'),
            [
                'import { fromHono } from "@boon4681/giri/adapters/hono";',
                '',
                '// A bare fromHono() (no stack()) still types c.get via its Vars generic.',
                'export const middleware =',
                '  fromHono<{ "user-google": { email: string } }>(async (_c, next) => { await next(); });',
            ].join('\n'),
        );
        await writeFile(
            join(routesDir, 'me', '+get.ts'),
            [
                'import type { Handle } from "./$types";',
                'export const handle: Handle = (c) => {',
                '  const email: string = c.get("user-google").email;',
                '  // @ts-expect-error user-google.email is a string, not a number',
                '  const bad: number = c.get("user-google").email;',
                '  return c.json({ email, bad });',
                '};',
            ].join('\n'),
        );
        await syncProject({ outDir }, { cwd: tmp });

        const program = ts.createProgram([join(routesDir, 'me', '+get.ts')], {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true,
            skipLibCheck: true,
            rootDirs: [routesDir, join(outDir, 'types', 'src', 'routes')],
            baseUrl: process.cwd(),
            paths: {
                '@boon4681/giri': ['src/index.ts'],
                '@boon4681/giri/adapters/hono': ['src/adapters/hono.ts'],
            },
            types: ['node'],
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        expect(diagnostics.map((diagnostic) => diagnostic.messageText)).toEqual([]);
    });

    it("infers c.get from a Hono middleware's own Env Variables (scoped, no generic)", async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'me'), { recursive: true });
        await writeFile(
            join(routesDir, 'me', '+shared.ts'),
            [
                'import { fromHono } from "@boon4681/giri/adapters/hono";',
                'import type { MiddlewareHandler } from "hono";',
                '',
                '// A middleware that types its own scoped Variables (Hono\'s per-handler Env scope).',
                'const auth: MiddlewareHandler<{ Variables: { user: { id: string } } }> =',
                '  async (_c, next) => { await next(); };',
                '',
                '// No generic needed - fromHono infers { user } from the handler\'s Env.',
                'export const middleware = fromHono(auth);',
            ].join('\n'),
        );
        await writeFile(
            join(routesDir, 'me', '+get.ts'),
            [
                'import type { Handle } from "./$types";',
                'export const handle: Handle = (c) => {',
                '  const id: string = c.get("user").id;',
                '  // @ts-expect-error user.id is a string, not a number',
                '  const bad: number = c.get("user").id;',
                '  return c.json({ id, bad });',
                '};',
            ].join('\n'),
        );
        await syncProject({ outDir }, { cwd: tmp });

        const program = ts.createProgram([join(routesDir, 'me', '+get.ts')], {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true,
            skipLibCheck: true,
            rootDirs: [routesDir, join(outDir, 'types', 'src', 'routes')],
            baseUrl: process.cwd(),
            paths: {
                '@boon4681/giri': ['src/index.ts'],
                '@boon4681/giri/adapters/hono': ['src/adapters/hono.ts'],
            },
            types: ['node'],
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        expect(diagnostics.map((diagnostic) => diagnostic.messageText)).toEqual([]);
    });

    it('does not leak a global ContextVariableMap augmentation onto a bare fromHono route', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'me'), { recursive: true });
        await writeFile(
            join(routesDir, 'me', '+shared.ts'),
            [
                'import { fromHono } from "@boon4681/giri/adapters/hono";',
                '',
                '// A plugin (e.g. @hono/oauth-providers) augments Hono\'s global ContextVariableMap',
                '// process-wide - but it is only applied under its own folder, not here.',
                'declare module "hono" {',
                '  interface ContextVariableMap {',
                '    "user-google": { email: string } | undefined;',
                '  }',
                '}',
                '',
                '// A bare fromHono (like cors) injects nothing: Vars default to {}, NOT the global map.',
                'export const middleware = fromHono(async (_c, next) => { await next(); });',
            ].join('\n'),
        );
        await writeFile(
            join(routesDir, 'me', '+get.ts'),
            [
                'import type { Handle } from "./$types";',
                'export const handle: Handle = (c) => {',
                '  // user-google is NOT in this route\'s middleware vars, so c.get falls back to unknown',
                '  // rather than the leaked global augmentation.',
                '  const user: unknown = c.get("user-google");',
                '  // @ts-expect-error unknown is not the augmented { email } shape - no leak',
                '  const email: string = c.get("user-google").email;',
                '  return c.json({ ok: true, user, email });',
                '};',
            ].join('\n'),
        );
        await syncProject({ outDir }, { cwd: tmp });

        const program = ts.createProgram([join(routesDir, 'me', '+get.ts')], {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true,
            skipLibCheck: true,
            rootDirs: [routesDir, join(outDir, 'types', 'src', 'routes')],
            baseUrl: process.cwd(),
            paths: {
                '@boon4681/giri': ['src/index.ts'],
                '@boon4681/giri/adapters/hono': ['src/adapters/hono.ts'],
            },
            types: ['node'],
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        expect(diagnostics.map((diagnostic) => diagnostic.messageText)).toEqual([]);
    });

    it('propagates folder middleware vars into a downstream handler c.get', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'admin'), { recursive: true });
        await writeFile(
            join(routesDir, '+shared.ts'),
            [
                'import { stack } from "@boon4681/giri";',
                'import type { Middleware } from "./$types";',
                'const auth: Middleware<{ user: string }> = async (c, next) => {',
                '  c.set("user", "ada");',
                '  await next();',
                '};',
                'export const middleware = stack(auth);',
            ].join('\n'),
        );
        await writeFile(
            join(routesDir, 'admin', '+get.ts'),
            [
                'import type { Handle } from "./$types";',
                'export const handle: Handle = (c) => {',
                '  const user: string = c.get("user");',
                '  // @ts-expect-error user is a string, not a number',
                '  const bad: number = c.get("user");',
                '  return c.json({ user, bad });',
                '};',
            ].join('\n'),
        );
        await syncProject({ outDir }, { cwd: tmp });

        const program = ts.createProgram(
            [join(routesDir, '+shared.ts'), join(routesDir, 'admin', '+get.ts')],
            {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                strict: true,
                skipLibCheck: true,
                rootDirs: [routesDir, join(outDir, 'types', 'src', 'routes')],
                baseUrl: process.cwd(),
                paths: { '@boon4681/giri': ['src/index.ts'] },
                types: ['node'],
            },
        );
        const diagnostics = ts.getPreEmitDiagnostics(program);
        expect(diagnostics.map((diagnostic) => diagnostic.messageText)).toEqual([]);
    });
});

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '../src';
import { hono } from '../src/adapters/hono';
import { buildProject } from '../src/generator/build';

const tmp = join(process.cwd(), 'test', '.tmp', 'build');

async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
    });
}

function startServer(file: string, cwd: string): Promise<{ url: string; child: ChildProcess }> {
    const child = spawn(process.execPath, [file, '--port', '0', '--host', '127.0.0.1'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
        let buffer = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            void stop(child);
            reject(new Error(`server did not start\n${buffer}`));
        }, 10000);
        const finish = (error?: Error, url?: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (error || !url) {
                void stop(child);
                reject(error ?? new Error(buffer));
                return;
            }
            resolve({ url, child });
        };
        child.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const match = /ready on (http:\/\/\S+)/.exec(buffer);
            if (match) {
                finish(undefined, match[1]);
            }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
        });
        child.on('exit', (code) => {
            finish(new Error(`server exited ${code}\n${buffer}`));
        });
    });
}

describe('giri build', () => {
    beforeEach(async () => {
        await rm(tmp, { recursive: true, force: true });
        await mkdir(join(tmp, 'src', 'routes', 'users', '[id]'), { recursive: true });
        await mkdir(join(tmp, '.giri'), { recursive: true });
        await writeFile(join(tmp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
        await writeFile(join(tmp, '.giri', 'openapi.json'), JSON.stringify({ openapi: '3.1.0' }));
        await writeFile(join(tmp, 'src', 'db.ts'), 'export const label = "bundled";');
        // Mirrors installed giri: CJS that require()s a package left external by the bundle.
        await writeFile(join(tmp, 'src', 'legacy.cjs'), 'module.exports = { hono: typeof require("hono").Hono };');
        await writeFile(
            join(tmp, 'src', 'main.ts'),
            'export const init = () => ({ token: "init" });',
        );
        await writeFile(
            join(tmp, 'src', 'routes', '+shared.ts'),
            'export const middleware = async (c, next) => { c.set("shared", "yes"); await next(); };',
        );
        await writeFile(
            join(tmp, 'src', 'routes', 'users', '[id]', '+get.ts'),
            [
                'import { label } from "$db";',
                'import legacy from "../../../legacy.cjs";',
                'export const handle = (c) => c.json({',
                '  id: c.params.id,',
                '  label,',
                '  legacy: legacy.hono,',
                '  shared: c.get("shared"),',
                '  token: c.app.token,',
                '  doc: require("$giri/openapi.json").openapi,',
                '});',
            ].join('\n'),
        );
        await writeFile(
            join(tmp, 'giri.config.ts'),
            [
                'import { defineConfig } from "@boon4681/giri/config";',
                'import { hono } from "@boon4681/giri/adapters/hono";',
                'export default defineConfig({',
                '  adapter: hono(),',
                '  outDir: ".giri",',
                '  alias: { "$db": "./src/db.ts" },',
                '});',
                '',
            ].join('\n'),
        );
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    it.each([
        ['the giri output directory', '.giri/server'],
        ['the source directory', 'src/dist'],
        ['the project root', '.'],
    ])('refuses to write into %s', async (_label, outDir) => {
        const config = defineConfig({ adapter: hono(), outDir: join(tmp, '.giri') });
        await expect(buildProject(config, { cwd: tmp, outDir, sync: false })).rejects.toThrow(/Refusing to write/);
    });

    it('runs without node_modules when dependencies are bundled as CommonJS', async () => {
        const result = await buildProject(defineConfig({
            adapter: hono(),
            outDir: join(tmp, '.giri'),
            alias: { $db: './src/db.ts' },
        }), {
            cwd: tmp,
            outDir: join(tmp, 'dist'),
            sync: false,
            includeDeps: true,
            format: 'cjs',
        });
        expect(result.outFile.endsWith('index.cjs')).toBe(true);

        // Outside the repo, so no ancestor node_modules can satisfy a leftover external import.
        const isolated = await mkdtemp(join(tmpdir(), 'giri-build-'));
        try {
            await copyFile(result.outFile, join(isolated, 'index.cjs'));
            const server = await startServer(join(isolated, 'index.cjs'), isolated);
            try {
                const response = await fetch(`${server.url}/users/7`);
                expect(response.status).toBe(200);
                await expect(response.json()).resolves.toMatchObject({ id: '7', legacy: 'function' });
            } finally {
                await stop(server.child);
            }
        } finally {
            await rm(isolated, { recursive: true, force: true });
        }
    });

    it('bundles routes, aliases, lifecycle, and $giri assets into runnable JS', async () => {
        const result = await buildProject(defineConfig({
            adapter: hono(),
            outDir: join(tmp, '.giri'),
            alias: { $db: './src/db.ts' },
        }), {
            cwd: tmp,
            outDir: join(tmp, 'dist'),
            sync: false,
        });

        const output = await readFile(result.outFile, 'utf8');
        expect(result.routeCount).toBe(1);
        expect(output).toContain('bundled');
        expect(output).not.toMatch(/from ["'][^"']+\+get\.ts["']/);
        expect(output).not.toContain('typescript');

        const server = await startServer(result.outFile, tmp);
        try {
            const response = await fetch(`${server.url}/users/7`);
            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toEqual({
                id: '7',
                label: 'bundled',
                legacy: 'function',
                shared: 'yes',
                token: 'init',
                doc: '3.1.0',
            });
        } finally {
            await stop(server.child);
        }
    });
});

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createWatchUpdater, syncProject } from '../src/generator';

const tmp = join(process.cwd(), 'test', '.tmp', 'watch');

describe('createWatchUpdater', () => {
    beforeEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    it('updates a verb content edit incrementally without regenerating $types', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'users'), { recursive: true });
        const verb = join(routesDir, 'users', '+post.ts');
        await writeFile(verb, 'export const handle = (c) => c.json({ ok: true }, 201);');

        const initial = await syncProject({ outDir }, { cwd: tmp });
        const updater = createWatchUpdater({ outDir }, initial);

        const typesFile = join(outDir, 'types', 'src', 'routes', 'users', '$types.d.ts');
        expect(existsSync(typesFile)).toBe(true);

        // Delete the generated $types, then edit only the handler body. The incremental hot path
        // must not regenerate $types (its content is independent of the file's contents).
        await rm(typesFile);
        await writeFile(verb, 'export const handle = (c) => c.json({ ok: false }, 200);');

        // Filenames are relative to the watched `src/` (the parent of routes).
        expect(await updater.apply('routes/users/+post.ts')).toBe('incremental');
        expect(existsSync(typesFile)).toBe(false);

        expect(await updater.apply('routes/users/+get.ts')).toBe('full');
        expect(existsSync(typesFile)).toBe(true);
    });

    it('purges the openapi.json require-cache so a rebuild serves the fresh spec', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'secret'), { recursive: true });
        const verb = join(routesDir, 'secret', '+get.ts');
        await writeFile(verb, 'export const handle = (c) => c.json({ ok: true });');

        const initial = await syncProject({ outDir }, { cwd: tmp });
        const updater = createWatchUpdater({ outDir }, initial);

        const requireJson = createRequire(join(tmp, 'noop.js'));
        const openapiPath = join(outDir, 'openapi.json');
        const before = requireJson(openapiPath) as { paths?: Record<string, { get?: unknown }> };
        expect(before.paths?.['/secret']?.get).toBeDefined();
        await writeFile(
            verb,
            'export const openapi = false;\nexport const handle = (c) => c.json({ ok: true });',
        );
        expect(await updater.apply('routes/secret/+get.ts')).toBe('incremental');
        const after = requireJson(openapiPath) as { paths?: Record<string, { get?: unknown }> };
        expect(after.paths?.['/secret']?.get).toBeUndefined();
    });

    it('treats a non-route source file (an imported helper) as a full sync', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(routesDir, { recursive: true });
        await writeFile(join(tmp, 'src', 'auth.ts'), 'export const auth = () => {};');
        await writeFile(join(routesDir, '+get.ts'), 'export const handle = (c) => c.json({ ok: true });');

        const initial = await syncProject({ outDir }, { cwd: tmp });
        const updater = createWatchUpdater({ outDir }, initial);

        expect(await updater.apply('auth.ts')).toBe('full');
    });

    it('falls back to a full sync when the platform reports no filename', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(routesDir, { recursive: true });
        await writeFile(join(routesDir, '+get.ts'), 'export const handle = (c) => c.json({ ok: true });');

        const initial = await syncProject({ outDir }, { cwd: tmp });
        const updater = createWatchUpdater({ outDir }, initial);

        expect(await updater.apply(null)).toBe('full');
    });
});

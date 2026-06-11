import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
        const cacheFile = join(outDir, '.sync-cache.json');
        const cacheBefore = await readFile(cacheFile, 'utf8');

        const typesFile = join(outDir, 'types', 'src', 'routes', 'users', '$types.d.ts');
        expect(existsSync(typesFile)).toBe(true);

        // Delete the generated $types, then edit only the handler body. The incremental hot path
        // must not regenerate $types (its content is independent of the file's contents).
        await rm(typesFile);
        await writeFile(verb, 'export const handle = (c) => c.json({ ok: false }, 200);');

        // Filenames are relative to the watched `src/` (the parent of routes).
        expect(await updater.apply('routes/users/+post.ts')).toBe('incremental');
        expect(existsSync(typesFile)).toBe(false);
        expect(await readFile(cacheFile, 'utf8')).not.toBe(cacheBefore);

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

    it('treats an unimported source file as a full sync', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(routesDir, { recursive: true });

        await writeFile(join(tmp, 'src', 'auth.ts'), 'export const auth = () => {};');
        await writeFile(join(routesDir, '+get.ts'), 'export const handle = (c) => c.json({ ok: true });');

        const initial = await syncProject({ outDir }, { cwd: tmp });
        const updater = createWatchUpdater({ outDir }, initial);

        expect(await updater.apply('auth.ts')).toBe('full');
    });

    it('rebuilds a route incrementally when a helper it imports changes', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'users'), { recursive: true });
        // A regular (statically-analyzed) route that imports a project-local helper. The route is
        // never `require`d during sync, so the import edge must come from static analysis, not the
        // runtime require.cache — otherwise editing the helper falls back to a full resync.
        await writeFile(join(tmp, 'src', 'db.ts'), 'export const listUsers = () => [{ id: "1" }];');
        await writeFile(
            join(routesDir, 'users', '+get.ts'),
            'import { listUsers } from "../../db";\nexport const handle = (c) => c.json({ users: listUsers() });',
        );

        const initial = await syncProject({ outDir }, { cwd: tmp });
        const updater = createWatchUpdater({ outDir }, initial);

        await writeFile(join(tmp, 'src', 'db.ts'), 'export const listUsers = () => [{ id: "2" }];');
        expect(await updater.apply('db.ts')).toBe('incremental');
    });

    it('rebuilds a route incrementally when a transitively imported file changes', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'users'), { recursive: true });
        // route -> db -> models: the deepest file must still map back to the route.
        await writeFile(join(tmp, 'src', 'models.ts'), 'export type User = { id: string };');
        await writeFile(
            join(tmp, 'src', 'db.ts'),
            'import type { User } from "./models";\nexport const listUsers = (): User[] => [{ id: "1" }];',
        );
        await writeFile(
            join(routesDir, 'users', '+get.ts'),
            'import { listUsers } from "../../db";\nexport const handle = (c) => c.json({ users: listUsers() });',
        );

        const initial = await syncProject({ outDir }, { cwd: tmp });
        const updater = createWatchUpdater({ outDir }, initial);

        await writeFile(join(tmp, 'src', 'models.ts'), 'export type User = { id: number };');
        expect(await updater.apply('models.ts')).toBe('incremental');
    });

    it('skips directory notifications instead of resyncing (no rebuild storm)', async () => {
        const routesDir = join(tmp, 'src', 'routes');
        const outDir = join(tmp, '.giri');
        await mkdir(join(routesDir, 'users'), { recursive: true });
        await writeFile(join(routesDir, 'users', '+get.ts'), 'export const handle = (c) => c.json({ ok: true });');

        const initial = await syncProject({ outDir }, { cwd: tmp });
        const updater = createWatchUpdater({ outDir }, initial);

        // A folder event (what Windows' recursive watch emits when files inside are touched) must
        // not trigger a full resync.
        expect(await updater.apply('routes')).toBe('skip');
        expect(await updater.apply('routes/users')).toBe('skip');
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

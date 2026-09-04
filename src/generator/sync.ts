import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveGiriPaths } from '../app';
import {
    routeParamsForDir,
    scanRouteFolders,
    scanRoutes,
    sharedFilesForDir,
    type ScannedRoute,
} from '../routes';
import type { GiriConfig, GiriPaths, HttpMethod } from '../types';
import { RouteInputError } from '../validation';
import { writeAppTypes } from './app-types';
import type { RouteInputSchemas } from './inputs';
import { writeManifest } from './manifest';
import { writeOpenApi } from './openapi';
import { writeParamTypes, type TypeFolder } from './param-types';
import { RouteResponseSchemaError } from './errors';
import type { RouteOpenApiMeta, RouteSecurity } from './route-meta';
import { writeRouteTypes } from './route-types';
import type { RouteResponses } from './schema';
import { writeTsConfig } from './tsconfig';
import { assertSafeOutDir, pruneDir, slash, typeFilePath } from './util';
import {
    createSyncSnapshot,
    readSyncCacheState,
    SYNC_CACHE_NAME,
    writeSyncCache,
} from './cache';

/** A `$types.d.ts` for every folder under `routes/` even empty/new ones. */
async function typeFolders(paths: GiriPaths, routes: ScannedRoute[]): Promise<TypeFolder[]> {
    // `scanRoutes` (tinyglobby) yields forward-slash paths while `scanRouteFolders` yields
    // native-separator paths, so key the map on a slash-normalized dir to match either form.
    const verbsByDir = new Map<string, { method: HttpMethod; file: string }[]>();
    for (const route of routes) {
        const key = slash(route.routeDir);
        const list = verbsByDir.get(key) ?? [];
        list.push({ method: route.method, file: route.file });
        verbsByDir.set(key, list);
    }

    const dirs = await scanRouteFolders(paths.routesDir);
    const sharedCache = new Map<string, string | undefined>();
    return dirs.map((dir) => ({
        dir,
        params: routeParamsForDir(paths.routesDir, dir),
        sharedFiles: sharedFilesForDir(paths.routesDir, dir, sharedCache),
        verbs: verbsByDir.get(slash(dir)) ?? [],
    }));
}

/** The per-route metadata maps feeding `manifest.json` / `openapi.json`. */
export interface SyncData {
    responsesByFile: Map<string, RouteResponses>;
    inputsByFile: Map<string, RouteInputSchemas>;
    securityByFile: Map<string, RouteSecurity>;
    hiddenFiles: Set<string>;
    openapiByFile: Map<string, RouteOpenApiMeta>;
}

export interface SyncResult {
    paths: GiriPaths;
    routes: ScannedRoute[];
    folders: TypeFolder[];
    /** Aggregated route metadata, so a watcher can update one route and re-serialize. */
    data: SyncData;
    /** True when metadata and generated files were reusable without extraction. */
    cacheHit: boolean;
}

/**
 * Walk each route's `handle` return type into per-status JSON Schema. Best-effort: a
 * broken project (or missing TypeScript) must not break `sync`, so failures yield an
 * empty map and the manifest simply omits `responses`.
 */
async function extractResponses(paths: GiriPaths, routes: ScannedRoute[]): Promise<Map<string, RouteResponses>> {
    const byFile = new Map<string, RouteResponses>();
    if (routes.length === 0) {
        return byFile;
    }

    try {
        const { createSchemaProgram, extractRouteResponses } = await import('./schema/index.js');
        const files = [...new Set(routes.map((route) => route.file))];
        // Include the generated global app.d.ts so `c.app` resolves to its real type.
        const appTypes = join(paths.outDir, 'types', 'app.d.ts');
        const roots = existsSync(appTypes) ? [...files, appTypes] : files;
        const program = createSchemaProgram(paths, roots);
        for (const file of files) {
            byFile.set(file, extractRouteResponses(program, file));
        }
    } catch (error) {
        console.warn(`giri: skipped response schema generation (${(error as Error).message}).`);
    }

    return byFile;
}

interface RuntimeMeta {
    responsesByFile: Map<string, RouteResponses>;
    inputsByFile: Map<string, RouteInputSchemas>;
    securityByFile: Map<string, RouteSecurity>;
    hiddenFiles: Set<string>;
    openapiByFile: Map<string, RouteOpenApiMeta>;
}

/** Load route modules once to derive input schemas, middleware security, and openapi metadata. */
async function extractMeta(
    config: Pick<GiriConfig, 'alias'>,
    paths: GiriPaths,
    routes: ScannedRoute[],
): Promise<RuntimeMeta> {
    const inputsByFile = new Map<string, RouteInputSchemas>();
    const responsesByFile = new Map<string, RouteResponses>();
    const securityByFile = new Map<string, RouteSecurity>();
    const hiddenFiles = new Set<string>();
    const openapiByFile = new Map<string, RouteOpenApiMeta>();
    if (routes.length === 0) {
        return { responsesByFile, inputsByFile, securityByFile, hiddenFiles, openapiByFile };
    }

    try {
        const { extractRouteMeta } = await import('./route-meta.js');
        const meta = await extractRouteMeta(config, paths, routes);
        for (const [file, entry] of meta) {
            if (entry.responses) {
                responsesByFile.set(file, entry.responses);
            }
            if (entry.input) {
                inputsByFile.set(file, entry.input);
            }
            if (entry.security) {
                securityByFile.set(file, entry.security);
            }
            if (entry.hidden) {
                hiddenFiles.add(file);
            }
            if (entry.openapi) {
                openapiByFile.set(file, entry.openapi);
            }
        }
    } catch (error) {
        // A validator owner conflict is an actionable config error - fail loudly rather than
        // silently shipping a route whose input/openapi is missing.
        if (error instanceof RouteInputError || error instanceof RouteResponseSchemaError) {
            throw error;
        }
        console.warn(`giri: skipped route metadata generation (${(error as Error).message}).`);
    }

    return { responsesByFile, inputsByFile, securityByFile, hiddenFiles, openapiByFile };
}

/**
 * Scan `routes/` and (re)generate the whole `.giri/` payload. Each artifact has its own
 * module under `src/generator/`. Files are overwritten **in place** (no upfront wipe), so
 * the editor never sees `tsconfig`/`$types` vanish during a slow regeneration; orphaned
 * files from removed routes are pruned at the end.
 */
export async function syncProject<App>(
    config: Pick<GiriConfig<App>, 'alias' | 'outDir'>,
    options: { cwd?: string } = {},
): Promise<SyncResult> {
    const paths = resolveGiriPaths(config, options.cwd);
    assertSafeOutDir(paths);
    const hadOutDir = existsSync(paths.outDir);
    const cache = await readSyncCacheState(paths);
    const [routes, folders, snapshot] = await Promise.all([
        scanRoutes(paths.routesDir),
        typeFolders(paths, []),
        createSyncSnapshot(config, paths, cache?.files),
    ]);
    // Fill verbs after the directory walk has completed without repeating that walk.
    const folderByDir = new Map(folders.map((folder) => [slash(folder.dir), folder]));
    for (const route of routes) folderByDir.get(slash(route.routeDir))?.verbs.push({ method: route.method, file: route.file });
    const cached = cache?.fingerprint === snapshot.fingerprint ? cache.data : undefined;

    const generatedFiles = [
        join(paths.outDir, 'tsconfig.json'),
        join(paths.outDir, 'manifest.json'),
        join(paths.outDir, 'openapi.json'),
        join(paths.outDir, 'routes.d.ts'),
        join(paths.outDir, 'types', 'app.d.ts'),
        ...folders.map((folder) => typeFilePath(paths, folder.dir)),
    ];
    if (cached && generatedFiles.every(existsSync)) {
        return { paths, routes, folders, data: cached, cacheHit: true };
    }

    await mkdir(paths.outDir, { recursive: true });
    await writeParamTypes(paths, folders);
    await writeRouteTypes(paths, routes);
    await writeAppTypes(paths);
    await writeTsConfig(paths, config);

    // Response schemas need the generated tsconfig + $types to resolve, so extract last.
    let data = cached;
    const routeShape = (route: ScannedRoute) => ({
        file: slash(relative(paths.cwd, route.file)),
        method: route.method,
        path: route.path,
        sharedFiles: route.sharedFiles.map((file) => slash(relative(paths.cwd, file))),
    });
    const sameStructure = cache && JSON.stringify(routes.map(routeShape)) === JSON.stringify(cache.routes);
    const changed = [...snapshot.changedFiles, ...snapshot.removedFiles];
    const canIncrement = cache && sameStructure && snapshot.removedFiles.length === 0 && changed.length > 0 &&
        changed.every((file) => slash(relative(paths.cwd, file)).startsWith('src/')) &&
        !changed.some((file) => /^src\/main\.(?:[cm]?[jt]s|[jt]sx)$/i.test(slash(relative(paths.cwd, file))));

    if (!data && canIncrement) {
        const [{ buildImportGraph }, { collectDependents }] = await Promise.all([
            import('../loader/import-graph.js'),
            import('../loader/module-loader.js'),
        ]);
        const graph = await buildImportGraph(config, paths.cwd);
        const dependents = new Set<string>();
        for (const file of changed) {
            for (const dependent of collectDependents(graph, slash(file))) dependents.add(dependent);
        }
        const affected = routes.filter((route) => dependents.has(slash(route.file)) ||
            route.sharedFiles.some((file) => dependents.has(slash(file))));
        data = cache.data;
        if (affected.length > 0) {
            for (const route of affected) {
                data.responsesByFile.delete(route.file);
                data.inputsByFile.delete(route.file);
                data.securityByFile.delete(route.file);
                data.hiddenFiles.delete(route.file);
                data.openapiByFile.delete(route.file);
            }
            const responses = await extractResponses(paths, affected);
            const meta = await extractMeta(config, paths, affected);
            for (const route of affected) {
                const file = route.file;
                const entry = meta.responsesByFile.get(file) ?? responses.get(file);
                if (entry) data.responsesByFile.set(file, entry);
                const input = meta.inputsByFile.get(file);
                if (input) data.inputsByFile.set(file, input);
                const security = meta.securityByFile.get(file);
                if (security) data.securityByFile.set(file, security);
                if (meta.hiddenFiles.has(file)) data.hiddenFiles.add(file);
                const openapi = meta.openapiByFile.get(file);
                if (openapi) data.openapiByFile.set(file, openapi);
            }
        }
    }
    if (!data) {
        const responsesByFile = await extractResponses(paths, routes);
        const meta = await extractMeta(config, paths, routes);
        for (const [file, responses] of meta.responsesByFile) {
            responsesByFile.set(file, responses);
        }
        data = { ...meta, responsesByFile };
    }
    await writeManifest(paths, routes, data);
    await writeOpenApi(paths, routes, data);
    await writeSyncCache(paths, snapshot.fingerprint, data, snapshot.files, routes);

    if (hadOutDir) {
        await pruneDir(
            paths.outDir,
            new Set([
                join(paths.outDir, 'tsconfig.json'),
                join(paths.outDir, 'manifest.json'),
                join(paths.outDir, 'openapi.json'),
                join(paths.outDir, 'routes.d.ts'),
                join(paths.outDir, SYNC_CACHE_NAME),
                join(paths.outDir, 'types', 'app.d.ts'),
                ...folders.map((folder) => typeFilePath(paths, folder.dir)),
            ]),
        );
    }

    return { paths, routes, folders, data, cacheHit: false };
}

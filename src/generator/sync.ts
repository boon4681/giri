import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveGiriPaths } from '../app';
import {
    routeParamsForDir,
    scanRouteFolders,
    scanRoutes,
    sharedFilesForDir,
    type ScannedRoute,
} from '../routes';
import type { GiriConfig, GiriPaths, HttpMethod } from '../types';
import { writeAppTypes } from './app-types';
import type { RouteInputSchemas } from './inputs';
import { writeManifest } from './manifest';
import { writeOpenApi } from './openapi';
import { writeParamTypes, type TypeFolder } from './param-types';
import { extractRouteMeta, type RouteSecurity } from './route-meta';
import { writeRouteTypes } from './route-types';
import { createSchemaProgram, extractRouteResponses, type RouteResponses } from './schema';
import { writeTsConfig } from './tsconfig';
import { assertSafeOutDir, pruneDir, slash, typeFilePath } from './util';

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
    return dirs.map((dir) => ({
        dir,
        params: routeParamsForDir(paths.routesDir, dir),
        sharedFiles: sharedFilesForDir(paths.routesDir, dir),
        verbs: verbsByDir.get(slash(dir)) ?? [],
    }));
}

/** The per-route metadata maps feeding `manifest.json` / `openapi.json`. */
export interface SyncData {
    responsesByFile: Map<string, RouteResponses>;
    inputsByFile: Map<string, RouteInputSchemas>;
    securityByFile: Map<string, RouteSecurity>;
    hiddenFiles: Set<string>;
}

export interface SyncResult {
    paths: GiriPaths;
    routes: ScannedRoute[];
    folders: TypeFolder[];
    /** Aggregated route metadata, so a watcher can update one route and re-serialize. */
    data: SyncData;
}

/**
 * Walk each route's `handle` return type into per-status JSON Schema. Best-effort: a
 * broken project (or missing TypeScript) must not break `sync`, so failures yield an
 * empty map and the manifest simply omits `responses`.
 */
function extractResponses(paths: GiriPaths, routes: ScannedRoute[]): Map<string, RouteResponses> {
    const byFile = new Map<string, RouteResponses>();
    if (routes.length === 0) {
        return byFile;
    }

    try {
        const files = [...new Set(routes.map((route) => route.file))];
        // Include the generated global app.d.ts so `c.app` resolves to its real type.
        const appTypes = join(paths.outDir, 'types', 'app.d.ts');
        const program = createSchemaProgram(
            paths,
            existsSync(appTypes) ? [...files, appTypes] : files,
        );
        for (const file of files) {
            byFile.set(file, extractRouteResponses(program, file));
        }
    } catch (error) {
        console.warn(`giri: skipped response schema generation (${(error as Error).message}).`);
    }

    return byFile;
}

interface RuntimeMeta {
    inputsByFile: Map<string, RouteInputSchemas>;
    securityByFile: Map<string, RouteSecurity>;
    hiddenFiles: Set<string>;
}

/** Load route modules once to derive input schemas, middleware security, and openapi visibility. */
async function extractMeta(
    config: Pick<GiriConfig, 'alias'>,
    paths: GiriPaths,
    routes: ScannedRoute[],
): Promise<RuntimeMeta> {
    const inputsByFile = new Map<string, RouteInputSchemas>();
    const securityByFile = new Map<string, RouteSecurity>();
    const hiddenFiles = new Set<string>();
    if (routes.length === 0) {
        return { inputsByFile, securityByFile, hiddenFiles };
    }

    try {
        const meta = await extractRouteMeta(config, paths, routes);
        for (const [file, entry] of meta) {
            if (entry.input) {
                inputsByFile.set(file, entry.input);
            }
            if (entry.security) {
                securityByFile.set(file, entry.security);
            }
            if (entry.hidden) {
                hiddenFiles.add(file);
            }
        }
    } catch (error) {
        console.warn(`giri: skipped input/security generation (${(error as Error).message}).`);
    }

    return { inputsByFile, securityByFile, hiddenFiles };
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
    const routes = await scanRoutes(paths.routesDir);
    const folders = await typeFolders(paths, routes);

    await mkdir(paths.outDir, { recursive: true });
    await writeParamTypes(paths, folders);
    await writeRouteTypes(paths, routes);
    await writeAppTypes(paths);
    await writeTsConfig(paths, config);

    // Response schemas need the generated tsconfig + $types to resolve, so extract last.
    const responsesByFile = extractResponses(paths, routes);
    const { inputsByFile, securityByFile, hiddenFiles } = await extractMeta(config, paths, routes);
    const data: SyncData = { responsesByFile, inputsByFile, securityByFile, hiddenFiles };
    await writeManifest(paths, routes, data);
    await writeOpenApi(paths, routes, data);

    await pruneDir(
        paths.outDir,
        new Set([
            join(paths.outDir, 'tsconfig.json'),
            join(paths.outDir, 'manifest.json'),
            join(paths.outDir, 'openapi.json'),
            join(paths.outDir, 'routes.d.ts'),
            join(paths.outDir, 'types', 'app.d.ts'),
            ...folders.map((folder) => typeFilePath(paths, folder.dir)),
        ]),
    );

    return { paths, routes, folders, data };
}

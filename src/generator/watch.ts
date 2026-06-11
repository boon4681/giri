import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildImportGraph } from '../loader/import-graph';
import {
    collectDependents,
    purgeGeneratedModules,
    purgeModules,
    purgeProjectModules,
} from '../loader/module-loader';
import type { ScannedRoute } from '../routes';
import type { GiriConfig } from '../types';
import { writeManifest } from './manifest';
import { writeOpenApi } from './openapi';
import { extractRouteMeta } from './route-meta';
import { syncFingerprint, writeSyncCache } from './cache';
import { syncProject, type SyncResult } from './sync';
import { slash } from './util';

export type ChangeOutcome = 'incremental' | 'full' | 'skip';

export interface WatchUpdater {
    /**
     * Apply one watch event. Returns 'incremental'/'full' for real changes, or 'skip' for
     * directory notifications (the real edit always arrives as a separate file event).
     */
    apply(filename: string | null): Promise<ChangeOutcome>;
}

export function createWatchUpdater(
    config: Pick<GiriConfig, 'alias' | 'outDir'>,
    initial: SyncResult,
): WatchUpdater {
    const paths = initial.paths;
    let routes = initial.routes;
    const data = initial.data;

    const fullResync = async (): Promise<ChangeOutcome> => {
        purgeProjectModules(paths.cwd);
        const result = await syncProject(config, { cwd: paths.cwd });
        routes = result.routes;
        data.responsesByFile = result.data.responsesByFile;
        data.inputsByFile = result.data.inputsByFile;
        data.securityByFile = result.data.securityByFile;
        data.hiddenFiles = result.data.hiddenFiles;
        data.openapiByFile = result.data.openapiByFile;
        purgeGeneratedModules(paths.outDir);
        return 'full';
    };

    /** Recompute just one route's response/input/security/visibility metadata in place. */
    const reextractRoute = async (route: ScannedRoute): Promise<void> => {
        const key = route.file;
        try {
            const { createSchemaProgram, extractRouteResponses } = await import('./schema/index.js');
            const appTypes = join(paths.outDir, 'types', 'app.d.ts');
            const program = createSchemaProgram(paths, existsSync(appTypes) ? [key, appTypes] : [key]);
            data.responsesByFile.set(key, extractRouteResponses(program, key));
        } catch {
            // keep the previous response schema on failure (e.g. mid-save / type error)
        }
        try {
            const meta = await extractRouteMeta(config, paths, [route]);
            const entry = meta.get(key);
            data.inputsByFile.delete(key);
            data.securityByFile.delete(key);
            data.hiddenFiles.delete(key);
            data.openapiByFile.delete(key);
            if (entry?.input) {
                data.inputsByFile.set(key, entry.input);
            }
            if (entry?.security) {
                data.securityByFile.set(key, entry.security);
            }
            if (entry?.hidden) {
                data.hiddenFiles.add(key);
            }
            if (entry?.openapi) {
                data.openapiByFile.set(key, entry.openapi);
            }
        } catch {
            // keep previous metadata on failure
        }
    };

    return {
        async apply(filename) {
            if (!filename) {
                return fullResync();
            }
            // Filenames arrive relative to the watched `src/` (the parent of routes).
            const abs = resolve(dirname(paths.routesDir), filename);
            const file = slash(abs);
            if (!existsSync(abs)) {
                return fullResync();
            }

            // Ignore directory notifications. Windows' recursive fs.watch emits a `change` for a
            // folder whenever a file inside it is touched - including the access-time bumps from
            // the schema TypeScript program reading every route - which would otherwise trigger a
            // full resync per folder (a rebuild storm). The real edit always arrives as a file event.
            if (statSync(abs).isDirectory()) {
                return 'skip';
            }

            const graph = await buildImportGraph(config, paths.cwd);
            const isRoute = routes.some((candidate) => slash(candidate.file) === file);

            if (!graph.nodes.has(file) && !isRoute) {
                return fullResync();
            }

            const dependents = collectDependents(graph, file);
            const affected = routes.filter((route) =>
                dependents.has(slash(route.file)) ||
                route.sharedFiles.some((shared) => dependents.has(slash(shared))),
            );
            purgeModules(dependents);
            for (const route of affected) {
                await reextractRoute(route);
            }
            await writeManifest(paths, routes, data);
            await writeOpenApi(paths, routes, data);
            await writeSyncCache(paths, await syncFingerprint(config, paths), data);
            purgeGeneratedModules(paths.outDir);
            return 'incremental';
        },
    };
}

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildModuleGraph, collectDependents, purgeModules, purgeProjectModules } from '../loader/module-loader';
import type { ScannedRoute } from '../routes';
import type { GiriConfig } from '../types';
import { writeManifest } from './manifest';
import { writeOpenApi } from './openapi';
import { extractRouteMeta } from './route-meta';
import { createSchemaProgram, extractRouteResponses } from './schema';
import { syncProject, type SyncResult } from './sync';
import { slash } from './util';

export type ChangeOutcome = 'incremental' | 'full';

export interface WatchUpdater {
    /** Apply one watch event; returns whether it was handled incrementally or fell back to full. */
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
        return 'full';
    };

    /** Recompute just one route's response/input/security/visibility metadata in place. */
    const reextractRoute = async (route: ScannedRoute): Promise<void> => {
        const key = route.file;
        try {
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
            if (entry?.input) {
                data.inputsByFile.set(key, entry.input);
            }
            if (entry?.security) {
                data.securityByFile.set(key, entry.security);
            }
            if (entry?.hidden) {
                data.hiddenFiles.add(key);
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

            const graph = buildModuleGraph(paths.cwd);
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
            return 'incremental';
        },
    };
}

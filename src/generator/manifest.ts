import { join, relative } from 'node:path';
import type { ScannedRoute } from '../routes';
import type { GiriPaths } from '../types';
import type { RouteInputSchemas } from './inputs';
import type { RouteSecurity } from './route-meta';
import type { RouteResponses } from './schema';
import { slash, typeFilePath, writeJson } from './util';

export interface ManifestData {
    responsesByFile?: Map<string, RouteResponses>;
    inputsByFile?: Map<string, RouteInputSchemas>;
    securityByFile?: Map<string, RouteSecurity>;
    hiddenFiles?: Set<string>;
}

/** Emits `manifest.json`: the machine-readable route table consumed by tooling. */
export async function writeManifest(
    paths: GiriPaths,
    routes: ScannedRoute[],
    data: ManifestData = {},
): Promise<void> {
    const manifest = {
        version: 1,
        routes: routes.map((route) => {
            const responses = data.responsesByFile?.get(route.file);
            const input = data.inputsByFile?.get(route.file);
            const security = data.securityByFile?.get(route.file);
            return {
                method: route.method,
                path: route.path,
                file: slash(relative(paths.cwd, route.file)),
                params: route.params,
                shared: route.sharedFiles.map((file) => slash(relative(paths.cwd, file))),
                types: slash(relative(paths.cwd, typeFilePath(paths, route.routeDir))),
                ...(data.hiddenFiles?.has(route.file) ? { hidden: true } : {}),
                ...(input ? { input } : {}),
                ...(security && security.security.length > 0 ? { security: security.security } : {}),
                responses: responses?.responses ?? [],
                ...(responses && Object.keys(responses.$defs).length > 0
                    ? { $defs: responses.$defs }
                    : {}),
            };
        }),
    };

    await writeJson(join(paths.outDir, 'manifest.json'), manifest);
}

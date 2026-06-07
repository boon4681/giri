import { join } from 'node:path';
import type { ScannedRoute } from '../routes';
import type { GiriPaths } from '../types';
import { GENERATED_HEADER, importPath, typeFilePath, writeGenerated } from './util';

/** Emits `routes.d.ts`: a `RouteParams` map keyed by `"METHOD path"` for the whole app. */
export async function writeRouteTypes(paths: GiriPaths, routes: ScannedRoute[]): Promise<void> {
    const file = join(paths.outDir, 'routes.d.ts');
    const lines = [
        GENERATED_HEADER,
        'export interface RouteParams {',
    ];

    for (const route of routes) {
        const typeFile = typeFilePath(paths, route.routeDir);
        lines.push(
            `  ${JSON.stringify(`${route.method} ${route.path}`)}: import(${JSON.stringify(
                importPath(file, typeFile),
            )}).Params;`,
        );
    }

    lines.push('}', '');
    await writeGenerated(file, lines.join('\n'));
}

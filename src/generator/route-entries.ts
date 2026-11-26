import { join } from 'node:path';
import { scanRoutes, type ScannedRoute } from '../routes';
import type { GiriPaths } from '../types';
import { GENERATED_HEADER, assertSafeOutDir, relativeConfigPath, writeGenerated } from './util';

export const ROUTE_ENTRIES_FILE = 'route-entries.ts';

export function renderRouteEntries(routes: ScannedRoute[], specifier: (file: string) => string) {
    const imports: string[] = [];
    const bindings = new Map<string, string>();
    const bind = (file: string): string => {
        const existing = bindings.get(file);
        if (existing) return existing;

        const name = `mod${bindings.size}`;
        bindings.set(file, name);
        imports.push(`import * as ${name} from ${JSON.stringify(specifier(file))};`);
        return name;
    };

    const entries = routes.map((route) => {
        const shared = route.sharedFiles.map(bind);
        const module = bind(route.file);
        const sharedField = shared.length > 0 ? `, shared: [${shared.join(', ')}]` : '';
        return `{ method: ${JSON.stringify(route.method)}, path: ${JSON.stringify(route.path)}, module: ${module}${sharedField} }`;
    });

    return { imports, entries };
}

export async function writeRouteEntries(paths: GiriPaths) {
    assertSafeOutDir(paths);
    const routes = await scanRoutes(paths.routesDir);
    const { imports, entries } = renderRouteEntries(routes, (file) => relativeConfigPath(paths.outDir, file));
    const file = join(paths.outDir, ROUTE_ENTRIES_FILE);
    await writeGenerated(file, [
        GENERATED_HEADER,
        'import type { GiriRuntimeRoute } from "@boon4681/giri/runtime";',
        ...imports,
        '',
        'export const routes = [',
        ...entries.map((entry) => `    ${entry},`),
        '] satisfies readonly GiriRuntimeRoute[];',
        '',
    ].join('\n'));

    return { file, routeCount: routes.length };
}

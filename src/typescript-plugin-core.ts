import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export interface ResolveGiriTypesImportOptions {
    moduleName: string;
    containingFile: string;
    projectDir: string;
    rootDirs?: readonly string[];
    fileExists?: (path: string) => boolean;
}

interface InferredRouteRoot {
    projectRoot: string;
    routesDir: string;
}

function unique(values: string[]): string[] {
    return [...new Set(values.map((value) => normalize(value)))];
}

function isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function absolutePath(projectDir: string, value: string): string {
    return isAbsolute(value) ? value : resolve(projectDir, value);
}

function inferRouteRoot(containingFile: string): InferredRouteRoot | undefined {
    const normalized = normalize(containingFile);
    const parts = normalized.split(sep);

    for (let index = parts.length - 2; index >= 0; index -= 1) {
        if (parts[index] === 'src' && parts[index + 1] === 'routes') {
            const projectRoot = parts.slice(0, index).join(sep) || sep;
            return {
                projectRoot,
                routesDir: parts.slice(0, index + 2).join(sep),
            };
        }
    }

    return undefined;
}

function routeKey(routesDir: string, routeDir: string): string {
    const rel = relative(routesDir, routeDir);
    return rel ? rel : '__root';
}

function rootDirsByKind(projectDir: string, rootDirs: readonly string[] | undefined): { routeRoots: string[]; generatedRoots: string[] } {
    const routeRoots: string[] = [];
    const generatedRoots: string[] = [];

    for (const rootDir of rootDirs ?? []) {
        const absolute = absolutePath(projectDir, rootDir);
        const normalized = normalize(absolute);
        if (
            normalized.includes(`${sep}.giri${sep}`) ||
            normalized.endsWith(`${sep}types${sep}routes`)
        ) {
            generatedRoots.push(normalized);
        } else {
            routeRoots.push(normalized);
        }
    }

    return { routeRoots, generatedRoots };
}

export function resolveGiriTypesImport(options: ResolveGiriTypesImportOptions): string | undefined {
    if (
        options.moduleName !== './$types' &&
        options.moduleName !== './$types.d.ts'
    ) {
        return undefined;
    }

    const fileExists = options.fileExists ?? existsSync;
    const containingDir = dirname(options.containingFile);
    const inferred = inferRouteRoot(options.containingFile);
    const fromRootDirs = rootDirsByKind(options.projectDir, options.rootDirs);

    const routeRoots = unique([
        ...(inferred ? [inferred.routesDir] : []),
        join(options.projectDir, 'src', 'routes'),
        ...fromRootDirs.routeRoots,
    ]);
    const generatedRoots = unique([
        ...(inferred ? [join(inferred.projectRoot, '.giri', 'types', 'routes')] : []),
        join(options.projectDir, '.giri', 'types', 'routes'),
        ...fromRootDirs.generatedRoots,
    ]);

    for (const routesDir of routeRoots) {
        if (!isInside(routesDir, containingDir)) {
            continue;
        }

        const key = routeKey(routesDir, containingDir);
        for (const generatedRoot of generatedRoots) {
            const candidate = join(generatedRoot, key, '$types.d.ts');
            if (fileExists(candidate)) {
                return candidate;
            }
        }
    }

    return undefined;
}

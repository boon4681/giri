import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { glob } from 'tinyglobby';
import type { GiriConfig, GiriPaths } from '../types';
import type { SyncData } from './sync';
import { slash, writeJson } from './util';

const CACHE_VERSION = 1;
export const SYNC_CACHE_NAME = '.sync-cache.json';

interface SyncCache {
    version: number;
    fingerprint: string;
    data: {
        responsesByFile: [string, unknown][];
        inputsByFile: [string, unknown][];
        securityByFile: [string, unknown][];
        hiddenFiles: string[];
        openapiByFile: [string, unknown][];
    };
}

function stableConfig(config: Pick<GiriConfig, 'alias' | 'outDir'>): unknown {
    const alias = Object.entries(config.alias ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]);
    return { alias, outDir: config.outDir ?? '.giri' };
}

/** Hash inputs that can affect generated route types, schemas, or OpenAPI metadata. */
export async function syncFingerprint(
    config: Pick<GiriConfig, 'alias' | 'outDir'>,
    paths: GiriPaths,
): Promise<string> {
    const outRelative = slash(relative(paths.cwd, paths.outDir));
    const ignore = ['**/node_modules/**', '**/.git/**'];
    if (outRelative && !outRelative.startsWith('..')) {
        ignore.push(`${outRelative}/**`);
    }

    const files = await glob([
        'src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}',
        'giri.config.{ts,js,mts,cts,mjs,cjs}',
        'tsconfig*.json',
        'package.json',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'bun.lock',
        'bun.lockb',
    ], {
        cwd: paths.cwd,
        absolute: false,
        onlyFiles: true,
        dot: true,
        ignore,
    });

    const hash = createHash('sha256');
    hash.update(JSON.stringify(stableConfig(config)));
    for (const file of files.sort()) {
        hash.update('\0');
        hash.update(slash(file));
        hash.update('\0');
        hash.update(await readFile(resolve(paths.cwd, file)));
    }
    return hash.digest('hex');
}

function cachePath(paths: GiriPaths): string {
    return join(paths.outDir, SYNC_CACHE_NAME);
}

function serializePath(paths: GiriPaths, file: string): string {
    return slash(relative(paths.cwd, file));
}

function deserializePath(paths: GiriPaths, file: string): string {
    return slash(resolve(paths.cwd, file.split('/').join(sep)));
}

function serializeMap<T>(paths: GiriPaths, values: Map<string, T>): [string, T][] {
    return [...values].map(([file, value]) => [serializePath(paths, file), value]);
}

function deserializeMap<T>(paths: GiriPaths, values: [string, T][]): Map<string, T> {
    return new Map(values.map(([file, value]) => [deserializePath(paths, file), value]));
}

export async function readSyncCache(
    paths: GiriPaths,
    fingerprint: string,
): Promise<SyncData | undefined> {
    const file = cachePath(paths);
    if (!existsSync(file)) {
        return undefined;
    }

    try {
        const cache = JSON.parse(await readFile(file, 'utf8')) as SyncCache;
        if (cache.version !== CACHE_VERSION || cache.fingerprint !== fingerprint) {
            return undefined;
        }
        return {
            responsesByFile: deserializeMap(paths, cache.data.responsesByFile),
            inputsByFile: deserializeMap(paths, cache.data.inputsByFile),
            securityByFile: deserializeMap(paths, cache.data.securityByFile),
            hiddenFiles: new Set(cache.data.hiddenFiles.map((entry) => deserializePath(paths, entry))),
            openapiByFile: deserializeMap(paths, cache.data.openapiByFile),
        } as SyncData;
    } catch {
        return undefined;
    }
}

export async function writeSyncCache(
    paths: GiriPaths,
    fingerprint: string,
    data: SyncData,
): Promise<void> {
    const cache: SyncCache = {
        version: CACHE_VERSION,
        fingerprint,
        data: {
            responsesByFile: serializeMap(paths, data.responsesByFile),
            inputsByFile: serializeMap(paths, data.inputsByFile),
            securityByFile: serializeMap(paths, data.securityByFile),
            hiddenFiles: [...data.hiddenFiles].map((file) => serializePath(paths, file)),
            openapiByFile: serializeMap(paths, data.openapiByFile),
        },
    };
    await writeJson(cachePath(paths), cache);
}

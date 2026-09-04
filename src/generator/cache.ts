import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { glob } from 'tinyglobby';
import type { ScannedRoute } from '../routes';
import type { GiriConfig, GiriPaths } from '../types';
import type { SyncData } from './sync';
import { slash, writeJson } from './util';

const CACHE_VERSION = 3;
export const SYNC_CACHE_NAME = '.sync-cache.json';

interface FileStamp {
    mtimeMs: number;
    ctimeMs: number;
    size: number;
    hash: string;
}

interface CachedRoute {
    file: string;
    method: string;
    path: string;
    sharedFiles: string[];
}

interface SyncCache {
    version: number;
    fingerprint: string;
    files: Record<string, FileStamp>;
    routes: CachedRoute[];
    data: {
        responsesByFile: [string, unknown][];
        inputsByFile: [string, unknown][];
        securityByFile: [string, unknown][];
        hiddenFiles: string[];
        openapiByFile: [string, unknown][];
    };
}

export interface SyncCacheState {
    fingerprint: string;
    files: Record<string, FileStamp>;
    routes: CachedRoute[];
    data: SyncData;
}

export interface SyncSnapshot {
    fingerprint: string;
    files: Record<string, FileStamp>;
    changedFiles: string[];
    removedFiles: string[];
}

function stableConfig(config: Pick<GiriConfig, 'alias' | 'outDir'>): unknown {
    const alias = Object.entries(config.alias ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]);
    return { alias, outDir: config.outDir ?? '.giri' };
}

async function inputFiles(paths: GiriPaths): Promise<string[]> {
    const outRelative = slash(relative(paths.cwd, paths.outDir));
    const ignore = ['**/node_modules/**', '**/.git/**'];
    if (outRelative && !outRelative.startsWith('..')) ignore.push(`${outRelative}/**`);
    return (await glob([
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
    ], { cwd: paths.cwd, absolute: false, onlyFiles: true, dot: true, ignore })).sort();
}

/** Reuse hashes for unchanged stat tuples and read changed files concurrently. */
export async function createSyncSnapshot(
    config: Pick<GiriConfig, 'alias' | 'outDir'>,
    paths: GiriPaths,
    previous: Record<string, FileStamp> = {},
): Promise<SyncSnapshot> {
    const names = await inputFiles(paths);
    const entries = await Promise.all(names.map(async (name): Promise<[string, FileStamp, boolean]> => {
        const normalized = slash(name);
        const file = resolve(paths.cwd, name);
        const info = await stat(file);
        const old = previous[normalized];
        if (old && old.mtimeMs === info.mtimeMs && old.ctimeMs === info.ctimeMs && old.size === info.size) {
            return [normalized, old, false];
        }
        const content = await readFile(file);
        return [normalized, {
            mtimeMs: info.mtimeMs,
            ctimeMs: info.ctimeMs,
            size: info.size,
            hash: createHash('sha256').update(content).digest('hex'),
        }, true];
    }));
    const files = Object.fromEntries(entries.map(([name, stamp]) => [name, stamp]));
    const changedFiles = entries.filter(([, , changed]) => changed).map(([name]) => resolve(paths.cwd, name));
    const removedFiles = Object.keys(previous).filter((name) => !(name in files)).map((name) => resolve(paths.cwd, name));
    const hash = createHash('sha256').update(JSON.stringify(stableConfig(config)));
    for (const [name, stamp] of entries) hash.update(`\0${name}\0${stamp.hash}`);
    return { fingerprint: hash.digest('hex'), files, changedFiles, removedFiles };
}

export async function syncFingerprint(
    config: Pick<GiriConfig, 'alias' | 'outDir'>,
    paths: GiriPaths,
): Promise<string> {
    return (await createSyncSnapshot(config, paths)).fingerprint;
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

function deserializeData(paths: GiriPaths, data: SyncCache['data']): SyncData {
    return {
        responsesByFile: deserializeMap(paths, data.responsesByFile),
        inputsByFile: deserializeMap(paths, data.inputsByFile),
        securityByFile: deserializeMap(paths, data.securityByFile),
        hiddenFiles: new Set(data.hiddenFiles.map((entry) => deserializePath(paths, entry))),
        openapiByFile: deserializeMap(paths, data.openapiByFile),
    } as SyncData;
}

export async function readSyncCacheState(paths: GiriPaths): Promise<SyncCacheState | undefined> {
    const file = cachePath(paths);
    if (!existsSync(file)) return undefined;
    try {
        const cache = JSON.parse(await readFile(file, 'utf8')) as SyncCache;
        if (cache.version !== CACHE_VERSION || !cache.files || !cache.routes) return undefined;
        return { fingerprint: cache.fingerprint, files: cache.files, routes: cache.routes, data: deserializeData(paths, cache.data) };
    } catch {
        return undefined;
    }
}

export async function readSyncCache(paths: GiriPaths, fingerprint: string): Promise<SyncData | undefined> {
    const cache = await readSyncCacheState(paths);
    return cache?.fingerprint === fingerprint ? cache.data : undefined;
}

export async function writeSyncCache(
    paths: GiriPaths,
    fingerprint: string,
    data: SyncData,
    snapshotFiles: Record<string, FileStamp> = {},
    routes: ScannedRoute[] = [],
): Promise<void> {
    const cache: SyncCache = {
        version: CACHE_VERSION,
        fingerprint,
        files: snapshotFiles,
        routes: routes.map((route) => ({
            file: serializePath(paths, route.file),
            method: route.method,
            path: route.path,
            sharedFiles: route.sharedFiles.map((file) => serializePath(paths, file)),
        })),
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

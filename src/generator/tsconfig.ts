import { join, resolve } from 'node:path';
import type { GiriConfig, GiriPaths } from '../types';
import { relativeConfigPath, writeJson } from './util';

function normalizeAlias(alias: GiriConfig['alias'], paths: GiriPaths): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(alias ?? {})) {
        const targets = Array.isArray(value) ? value : [value];
        // Alias values are written relative to the project root (the same base the
        // runtime resolver in app.ts uses), but the generated tsconfig lives in
        // outDir, so re-base each target onto outDir to keep them relative.
        result[key] = targets.map((target) =>
            relativeConfigPath(paths.outDir, resolve(paths.cwd, target)),
        );
    }
    return result;
}

/** Emits the `.giri/tsconfig.json` the project extends: rootDirs merge, aliases, plugin. */
export async function writeTsConfig(paths: GiriPaths, config: Pick<GiriConfig, 'alias'>): Promise<void> {
    const file = join(paths.outDir, 'tsconfig.json');
    await writeJson(file, {
        compilerOptions: {
            rootDirs: [
                '..',
                './types',
            ],
            paths: {
                // The tsconfig lives in outDir, so `$giri/*` maps to its own folder.
                '$giri/*': ['./*'],
                ...normalizeAlias(config.alias, paths),
            },
            plugins: [
                {
                    name: 'giri/tsc',
                },
            ],
        },
        include: [
            relativeConfigPath(paths.outDir, join(paths.cwd, 'src')),
            relativeConfigPath(paths.outDir, join(paths.cwd, 'giri.config.ts')),
            './types/**/*.d.ts',
        ],
    });
}

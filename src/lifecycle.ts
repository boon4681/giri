import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { safeRegister } from './loader/loader';
import type { Services } from './types';

const MAIN_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];

export interface GiriLifecycle {
    /** Absolute path to the resolved `src/main.ts`, if one exists. */
    file?: string;
    /** Runtime startup: build the app's service container, awaited before serving. */
    init?: () => Services | Promise<Services>;
    /** Graceful shutdown: receives the container from `init`, run on process exit. */
    teardown?: (services: Services) => void | Promise<void>;
}

function resolveMainFile(cwd: string): string | undefined {
    for (const ext of MAIN_EXTENSIONS) {
        const file = join(cwd, 'src', `main.${ext}`);
        if (existsSync(file)) {
            return file;
        }
    }
    return undefined;
}

/**
 * Load the optional `src/main.ts` lifecycle module. Absent file ⇒ empty lifecycle
 * (serve immediately). `init`/`teardown` are validated to be functions if present.
 */
export async function loadLifecycle(cwd = process.cwd()): Promise<GiriLifecycle> {
    const file = resolveMainFile(resolve(cwd));
    if (!file) {
        return {};
    }

    const { unregister } = await safeRegister();
    try {
        const resolved = require.resolve(file);
        delete require.cache[resolved];
        const loaded = require(resolved) as Partial<GiriLifecycle>;

        const lifecycle: GiriLifecycle = { file };
        if (loaded.init !== undefined) {
            if (typeof loaded.init !== 'function') {
                throw new Error(`${file}: "init" must be a function.`);
            }
            lifecycle.init = loaded.init;
        }
        if (loaded.teardown !== undefined) {
            if (typeof loaded.teardown !== 'function') {
                throw new Error(`${file}: "teardown" must be a function.`);
            }
            lifecycle.teardown = loaded.teardown;
        }
        return lifecycle;
    } finally {
        unregister();
    }
}

/** Run `init()` once and normalize its result into a service container. */
export async function runInit(lifecycle: GiriLifecycle): Promise<Services> {
    if (!lifecycle.init) {
        return {} as Services;
    }
    const services = await lifecycle.init();
    return (services ?? {}) as Services;
}

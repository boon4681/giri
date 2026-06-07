#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildGiriApp } from './app';
import { load } from './loader/loader';
import { createWatchUpdater, syncProject } from './generator';
import { loadLifecycle, runInit } from './lifecycle';
import { log, muted } from './logger';
import type { Services, GiriConfig, GiriFetchHandler, GiriServer } from './types';

interface ParsedFlags {
    port?: number;
    hostname?: string;
    watch: boolean;
}

function help(): void {
    console.log(`giri

Usage:
  giri init
  giri sync
  giri serve [--port 3000] [--host 127.0.0.1] [--no-watch]
  giri build
`);
}

function parseFlags(args: string[]): ParsedFlags {
    const flags: ParsedFlags = { watch: true };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--port' || arg === '-p') {
            flags.port = Number(args[++index]);
        } else if (arg === '--host' || arg === '--hostname') {
            flags.hostname = args[++index];
        } else if (arg === '--no-watch') {
            flags.watch = false;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    return flags;
}

async function ensureGitignore(cwd: string): Promise<void> {
    const file = join(cwd, '.gitignore');
    const entry = '.giri';
    if (!existsSync(file)) {
        await writeFile(file, `${entry}\n`);
        return;
    }

    const content = await readFile(file, 'utf8');
    if (!content.split(/\r?\n/).includes(entry)) {
        await appendFile(file, `${content.endsWith('\n') ? '' : '\n'}${entry}\n`);
    }
}

async function ensureTsConfig(cwd: string): Promise<void> {
    const file = join(cwd, 'tsconfig.json');
    if (existsSync(file)) {
        return;
    }

    await writeFile(
        file,
        `${JSON.stringify(
            {
                extends: './.giri/tsconfig.json',
                compilerOptions: {
                    target: 'ES2022',
                    lib: ['ES2022', 'DOM'],
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    strict: true,
                    esModuleInterop: true,
                    forceConsistentCasingInFileNames: true,
                    skipLibCheck: true,
                    types: ['node'],
                },
            },
            null,
            2,
        )}\n`,
    );
}

async function initProject(cwd: string): Promise<void> {
    const configPath = join(cwd, 'giri.config.ts');
    if (!existsSync(configPath)) {
        await writeFile(
            configPath,
            [
                'import { defineConfig } from "giri";',
                'import { hono } from "giri/adapters/hono";',
                '',
                'export default defineConfig({',
                '   adapter: hono(),',
                '});',
                '',
            ].join('\n'),
        );
    }

    const routePath = join(cwd, 'src', 'routes', '+get.ts');
    if (!existsSync(routePath)) {
        await mkdir(join(cwd, 'src', 'routes'), { recursive: true });
        await writeFile(
            routePath,
            [
                'import type { Handle } from "giri";',
                '',
                'export const handle: Handle = (c) => c.json({ ok: true });',
                '',
            ].join('\n'),
        );
    }

    await ensureGitignore(cwd);
    await ensureTsConfig(cwd);
    log.success('initialized giri project', 'init');
}

function displayHost(address: string): string {
    if (!address || address === '::' || address === '0.0.0.0') {
        return 'localhost';
    }
    return address.includes(':') ? `[${address}]` : address;
}

async function serveProject(config: GiriConfig, flags: ParsedFlags): Promise<void> {
    const initial = await syncProject(config);
    log.success(
        `synced ${initial.routes.length} route${initial.routes.length === 1 ? '' : 's'} ${muted(`at ${initial.paths.outDir}`)}`,
        'sync',
    );

    // Run the optional src/main.ts `init()` once, before serving. It owns long-lived
    // services (DB pools, etc.) that must survive watch rebuilds
    const lifecycle = await loadLifecycle();
    const services: Services = await runInit(lifecycle);

    let current = await buildGiriApp(config, { services });

    const port = flags.port ?? config.server?.port ?? 3000;
    const hostname = flags.hostname ?? config.server?.hostname;

    if (flags.watch) {
        // Watch the whole `src/`, not just `src/routes`: a route's imports (auth.ts, db.ts, …)
        // and `main.ts` live here, and editing them must rebuild too.
        const srcDir = resolve(current.paths.routesDir, '..');
        if (existsSync(srcDir)) {
            let timer: NodeJS.Timeout | undefined;
            let syncing = false;
            const changed = new Set<string>();
            const { watch } = await import('node:fs');
            const updater = createWatchUpdater(config, initial);
            const hmrCount = new Map<string, number>();
            const bump = (key: string): number => {
                const next = (hmrCount.get(key) ?? 0) + 1;
                hmrCount.set(key, next);
                return next;
            };

            // Drain queued changes, applying each through the incremental updater (it falls back
            // to a full sync for structural changes). Serialized so two drains never overlap;
            // changes arriving mid-drain are picked up by the loop or the trailing re-check.
            const flush = async (): Promise<void> => {
                if (syncing) {
                    return;
                }
                syncing = true;
                try {
                    while (changed.size > 0) {
                        const batch = [...changed];
                        changed.clear();
                        for (const name of batch) {
                            const outcome = await updater.apply(name || null);
                            const rel = name ? `src/${name.replace(/\\/g, '/')}` : 'src';
                            log.change(outcome === 'full' ? 'sync' : 'update', rel, bump(rel));
                        }
                        current = await buildGiriApp(config, { services });
                    }
                } catch (error) {
                    log.error(error instanceof Error ? error.message : String(error), 'watch');
                } finally {
                    syncing = false;
                }
                if (changed.size > 0) {
                    void flush();
                }
            };

            watch(srcDir, { recursive: true }, (_event, filename) => {
                changed.add(filename ? filename.toString() : '');
                clearTimeout(timer);
                timer = setTimeout(() => void flush(), 150);
            });
        }
    }

    const handler: GiriFetchHandler = (request) => config.adapter.fetch(current.app, request);

    const server = config.adapter.serve(handler, { port, hostname }, (info) => {
        log.ready(`http://${displayHost(info.address)}:${info.port}`);
    });

    registerShutdown(server, lifecycle, services);
}

function registerShutdown(
    server: GiriServer,
    lifecycle: { teardown?: (services: Services) => void | Promise<void> },
    services: Services,
): void {
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        try {
            await server.close();
            if (lifecycle.teardown) {
                await lifecycle.teardown(services);
            }
        } catch (error) {
            log.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        } finally {
            process.exit(process.exitCode ?? 0);
        }
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
}

async function main(): Promise<void> {
    const [command = 'help', ...args] = process.argv.slice(2);
    const cwd = resolve(process.cwd());

    if (command === 'help' || command === '--help' || command === '-h') {
        help();
        return;
    }

    if (command === 'init') {
        await initProject(cwd);
        return;
    }

    if (command === 'build') {
        log.warn('build is planned, but is currently a no-op', 'build');
        return;
    }

    const config = await load();

    if (command === 'sync') {
        const result = await syncProject(config);
        log.success(
            `synced ${result.routes.length} route${result.routes.length === 1 ? '' : 's'} ${muted(`at ${result.paths.outDir}`)}`,
            'sync',
        );
        return;
    }

    if (command === 'serve') {
        await serveProject(config, parseFlags(args));
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as prompts from '@clack/prompts';
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

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

interface AdapterChoice {
    value: string;
    label: string;
    hint: string;
    available: boolean;
    /** Import line added to `giri.config.ts`. */
    importLine: string;
    /** The adapter expression placed in `defineConfig({ adapter: … })`. */
    expr: string;
    /** Runtime deps this backend needs, installed alongside the framework. */
    deps: string[];
}

const ADAPTERS: AdapterChoice[] = [
    {
        value: 'hono',
        label: 'Hono',
        hint: 'recommended, ships today',
        available: true,
        importLine: 'import { hono } from "@boon4681/giri/adapters/hono";',
        expr: 'hono()',
        deps: ['hono', '@hono/node-server'],
    }
];

interface InitFlags {
    adapter?: string;
    packageManager?: PackageManager;
    /** undefined = ask; true/false = forced by --install / --no-install. */
    install?: boolean;
    /** Non-interactive: take defaults (Hono, detected PM, install). */
    yes: boolean;
}

function help(): void {
    console.log(`giri

Usage:
  giri init [--adapter hono] [--pm npm|yarn|pnpm|bun] [--no-install] [-y]
  giri sync
  giri serve [--port 3000] [--host 127.0.0.1] [--no-watch]
  giri build
`);
}

function parseInitFlags(args: string[]): InitFlags {
    const flags: InitFlags = { yes: false };
    const managers: PackageManager[] = ['npm', 'yarn', 'pnpm', 'bun'];

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--adapter' || arg === '-a') {
            flags.adapter = args[++index];
        } else if (arg === '--pm' || arg === '--package-manager') {
            const value = args[++index];
            if (!managers.includes(value as PackageManager)) {
                throw new Error(`Unknown package manager: ${value} (expected ${managers.join(', ')})`);
            }
            flags.packageManager = value as PackageManager;
        } else if (arg === '--install') {
            flags.install = true;
        } else if (arg === '--no-install') {
            flags.install = false;
        } else if (arg === '-y' || arg === '--yes') {
            flags.yes = true;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    return flags;
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

async function missingDeps(cwd: string, candidates: string[]): Promise<string[]> {
    let pkg: Record<string, unknown> = {};
    try {
        pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
    } catch {
        // No/!valid package.json — treat everything as missing (init already guards this case).
    }

    const present = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const map = pkg[field];
        if (map && typeof map === 'object') {
            for (const name of Object.keys(map as Record<string, unknown>)) {
                present.add(name);
            }
        }
    }

    return candidates.filter((name) => !present.has(name));
}

/** Guess the package manager from the user agent npm/yarn/pnpm/bun set when invoking the CLI. */
function detectPackageManager(): PackageManager {
    const ua = process.env.npm_config_user_agent ?? '';
    if (ua.startsWith('yarn')) return 'yarn';
    if (ua.startsWith('pnpm')) return 'pnpm';
    if (ua.startsWith('bun')) return 'bun';
    return 'npm';
}

function installArgs(pm: PackageManager, deps: string[], dev: boolean): string[] {
    if (pm === 'npm') return ['install', ...(dev ? ['--save-dev'] : []), ...deps];
    if (pm === 'bun') return ['add', ...(dev ? ['--dev'] : []), ...deps];
    return ['add', ...(dev ? ['--dev'] : []), ...deps]; // yarn, pnpm
}

/** Run a package-manager command, streaming its output. On Windows the binaries are `.cmd` shims. */
function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolvePromise();
            } else {
                reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
            }
        });
    });
}

function configSource(adapter: AdapterChoice): string {
    return [
        'import { defineConfig } from "@boon4681/giri";',
        adapter.importLine,
        '',
        'export default defineConfig({',
        `   adapter: ${adapter.expr},`,
        '});',
        '',
    ].join('\n');
}

/** Prompt for the adapter (or take the default in non-interactive mode). Null = the user cancelled. */
async function selectAdapter(interactive: boolean): Promise<AdapterChoice | null> {
    if (!interactive || ADAPTERS.length === 1) {
        return ADAPTERS[0];
    }

    const picked = await prompts.select({
        message: 'Which backend adapter?',
        initialValue: 'hono',
        options: ADAPTERS.map((adapter) => ({
            value: adapter.value,
            label: adapter.label,
            hint: adapter.hint,
        })),
    });
    if (prompts.isCancel(picked)) {
        return null;
    }
    return ADAPTERS.find((adapter) => adapter.value === picked) ?? null;
}

async function initProject(cwd: string, flags: InitFlags): Promise<void> {
    if (!existsSync(join(cwd, 'package.json'))) {
        throw new Error(
            'No package.json found. Run `giri init` inside an existing project - set one up first ' +
                '(e.g. `npm init -y` and install typescript), then re-run.',
        );
    }

    const interactive = Boolean(process.stdout.isTTY) && !flags.yes;
    prompts.intro('giri init');

    let adapter: AdapterChoice | null;
    if (flags.adapter) {
        adapter = ADAPTERS.find((choice) => choice.value === flags.adapter) ?? null;
        if (!adapter) {
            prompts.cancel(`Unknown adapter "${flags.adapter}". Available: ${ADAPTERS.map((a) => a.value).join(', ')}.`);
            return;
        }
    } else {
        adapter = await selectAdapter(interactive);
        if (!adapter) {
            prompts.cancel('Cancelled.');
            return;
        }
    }

    if (!adapter.available) {
        prompts.cancel(`The ${adapter.label} adapter isn't available yet - only Hono ships today.`);
        return;
    }

    const configPath = join(cwd, 'giri.config.ts');
    if (!existsSync(configPath)) {
        await writeFile(configPath, configSource(adapter));
    }

    const routePath = join(cwd, 'src', 'routes', '+get.ts');
    if (!existsSync(routePath)) {
        await mkdir(join(cwd, 'src', 'routes'), { recursive: true });
        await writeFile(
            routePath,
            [
                'import type { Handle } from "@boon4681/giri";',
                '',
                'export const handle: Handle = (c) => c.json({ ok: true });',
                '',
            ].join('\n'),
        );
    }

    await ensureGitignore(cwd);
    await ensureTsConfig(cwd);
    prompts.log.success(`scaffolded a ${adapter.label} project`);

    const pm = flags.packageManager ?? detectPackageManager();
    const deps = await missingDeps(cwd, ['@boon4681/giri', ...adapter.deps, 'zod']);
    const devDeps = await missingDeps(cwd, ['typescript', '@types/node']);

    if (deps.length === 0 && devDeps.length === 0) {
        prompts.outro('All dependencies already present. Run `giri serve` to start the dev server.');
        return;
    }

    const planLines = [
        ...(deps.length ? [`  ${pm} ${installArgs(pm, deps, false).join(' ')}`] : []),
        ...(devDeps.length ? [`  ${pm} ${installArgs(pm, devDeps, true).join(' ')}`] : []),
    ];

    let install = flags.install;
    if (install === undefined) {
        if (!interactive) {
            install = flags.yes;
        } else {
            const answer = await prompts.confirm({ message: `Install dependencies with ${pm}?` });
            if (prompts.isCancel(answer)) {
                prompts.cancel('Cancelled - files written, skipped install.');
                return;
            }
            install = answer;
        }
    }

    if (install) {
        try {
            if (deps.length) {
                prompts.log.step(`Installing ${deps.join(', ')}`);
                await runCommand(pm, installArgs(pm, deps, false), cwd);
            }
            if (devDeps.length) {
                prompts.log.step(`Installing dev deps ${devDeps.join(', ')}`);
                await runCommand(pm, installArgs(pm, devDeps, true), cwd);
            }
        } catch (error) {
            prompts.log.error(error instanceof Error ? error.message : String(error));
            prompts.outro(`Install failed - run these yourself, then \`giri serve\`:\n${planLines.join('\n')}`);
            return;
        }
        prompts.outro('Ready. Run `giri serve` to start the dev server.');
        return;
    }

    prompts.outro(`Next:\n${planLines.join('\n')}\n  giri serve`);
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
        await initProject(cwd, parseInitFlags(args));
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

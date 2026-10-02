import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { resolveAliasRequest, resolveGiriPaths } from '../app';
import { findConfigPath } from '../loader/loader';
import { scanRoutes, type ScannedRoute } from '../routes';
import type { GiriConfig } from '../types';
import { syncProject } from './sync';
import { slash } from './util';

const GIRI_PACKAGE = '@boon4681/giri';

export interface BuildProjectOptions {
    cwd?: string;
    /** Directory for the server bundle. Defaults to `dist`. */
    outDir?: string;
    minify?: boolean;
    /** Bundle `node_modules` dependencies too, so the output runs without them installed. */
    includeDeps?: boolean;
    /** Output module format. Defaults to the nearest `package.json` `type`. */
    format?: 'esm' | 'cjs';
    /** Regenerate `.giri/` before bundling. Defaults to true. */
    sync?: boolean;
}

export interface BuildProjectResult {
    outFile: string;
    routeCount: number;
}

function isWithin(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function specifier(cwd: string, file: string): string {
    const rel = relative(cwd, file);
    if (isAbsolute(rel)) {
        return slash(file);
    }
    const normalized = slash(rel);
    return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

async function outputFormat(cwd: string): Promise<'esm' | 'cjs'> {
    let dir = resolve(cwd);
    while (true) {
        const file = join(dir, 'package.json');
        if (existsSync(file)) {
            const pkg = JSON.parse(await readFile(file, 'utf8')) as { type?: string };
            return pkg.type === 'module' ? 'esm' : 'cjs';
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return 'cjs';
        }
        dir = parent;
    }
}

function resolveMainFile(cwd: string): string | undefined {
    for (const ext of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']) {
        const file = join(cwd, 'src', `main.${ext}`);
        if (existsSync(file)) {
            return file;
        }
    }
    return undefined;
}

function giriPackageDir(): string {
    // Published CLI inlines this file into dist/cli.js, so the runtime emit sits beside it.
    if (existsSync(join(__dirname, 'runtime.js')) || existsSync(join(__dirname, 'runtime.mjs'))) {
        return __dirname;
    }
    const parent = join(__dirname, '..');
    if (existsSync(join(parent, 'runtime.ts')) || existsSync(join(parent, 'runtime.js'))) {
        return parent;
    }
    throw new Error('Could not locate giri package files to bundle.');
}

function resolveGiriFile(rel: string): string | undefined {
    const root = giriPackageDir();
    for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs']) {
        const file = join(root, rel + ext);
        if (existsSync(file)) {
            return file;
        }
    }
    return undefined;
}

function giriSubpath(request: string): string | undefined {
    if (!request.startsWith(`${GIRI_PACKAGE}/`)) {
        return undefined;
    }
    const sub = request.slice(GIRI_PACKAGE.length + 1);
    switch (sub) {
        case 'runtime':
            return 'runtime';
        case 'config':
            return 'config';
        case 'hono':
        case 'adapters/hono':
            return 'adapters/hono';
        case 'validators/zod':
            return 'validators/zod';
        case 'validators/valibot':
            return 'validators/valibot';
        case 'tsc':
            return 'typescript-plugin';
        default:
            return sub;
    }
}

function renderEntry(cwd: string, configFile: string, mainFile: string | undefined, routes: ScannedRoute[]): string {
    const bindings = new Map<string, string>();
    const imports = [
        `import { createApp } from ${JSON.stringify(GIRI_PACKAGE + '/runtime')};`,
        `import config from ${JSON.stringify(specifier(cwd, configFile))};`,
    ];
    if (mainFile) {
        imports.push(`const lifecyclePromise = import(${JSON.stringify(specifier(cwd, mainFile))});`);
    } else {
        imports.push('const lifecyclePromise = Promise.resolve({});');
    }

    const bind = (file: string): string => {
        const existing = bindings.get(file);
        if (existing) {
            return existing;
        }
        const name = `mod${bindings.size}`;
        bindings.set(file, name);
        imports.push(`import * as ${name} from ${JSON.stringify(specifier(cwd, file))};`);
        return name;
    };

    const descriptors = routes.map((route) => {
        const shared = route.sharedFiles.map((file) => bind(file));
        const moduleName = bind(route.file);
        const sharedField = shared.length > 0 ? `, shared: [${shared.join(', ')}]` : '';
        return `{ method: ${JSON.stringify(route.method)}, path: ${JSON.stringify(route.path)}, module: ${moduleName}${sharedField} }`;
    });

    return [
        ...imports,
        '',
        'function flag(...names) {',
        '    const args = process.argv.slice(2);',
        '    for (let index = 0; index < args.length; index += 1) {',
        '        for (const name of names) {',
        '            if (args[index] === name) return args[index + 1];',
        '            if (args[index].startsWith(name + "=")) return args[index].slice(name.length + 1);',
        '        }',
        '    }',
        '    return undefined;',
        '}',
        '',
        'async function main() {',
        '    const portFlag = flag("--port", "-p");',
        '    const port = portFlag === undefined ? (config.server?.port ?? 3000) : Number(portFlag);',
        '    if (!Number.isInteger(port) || port < 0 || port > 65535) {',
        '        throw new Error("Invalid --port: " + portFlag);',
        '    }',
        '    const hostname = flag("--host", "--hostname") ?? config.server?.hostname;',
        '    const lifecycle = await lifecyclePromise;',
        '    const init = lifecycle["init"];',
        '    const teardown = lifecycle["teardown"];',
        '    const services = typeof init === "function" ? await init() : {};',
        '    const app = createApp({',
        '        adapter: config.adapter,',
        '        routes: [',
        ...descriptors.map((descriptor) => `            ${descriptor},`),
        '        ],',
        '        services,',
        '        cookieSecret: config.cookieSecret,',
        '    });',
        '    const server = config.adapter.serve(',
        '        (request) => config.adapter.fetch(app, request),',
        '        { port, hostname },',
        '        (info) => {',
        '            const address = !info.address || info.address === "::" || info.address === "0.0.0.0"',
        '                ? "localhost"',
        '                : info.address.includes(":") ? "[" + info.address + "]" : info.address;',
        '            console.log("ready on http://" + address + ":" + info.port);',
        '        },',
        '    );',
        '    let closing = false;',
        '    const shutdown = async () => {',
        '        if (closing) return;',
        '        closing = true;',
        '        let exitCode = 0;',
        '        try {',
        '            await server.close();',
        '        } catch (error) {',
        '            console.error(error);',
        '            exitCode = 1;',
        '        }',
        '        try {',
        '            if (typeof teardown === "function") await teardown(services);',
        '        } catch (error) {',
        '            console.error(error);',
        '            exitCode = 1;',
        '        }',
        '        process.exit(exitCode);',
        '    };',
        '    process.once("SIGINT", () => { void shutdown(); });',
        '    process.once("SIGTERM", () => { void shutdown(); });',
        '}',
        '',
        'main().catch((error) => {',
        '    console.error(error);',
        '    process.exit(1);',
        '});',
        '',
    ].join('\n');
}

function bundlePlugin(cwd: string, alias: GiriConfig['alias'], giriOutDir: string): Plugin {
    const runtimeFile = resolveGiriFile('runtime');
    const configFile = resolveGiriFile('config');
    if (!runtimeFile || !configFile) {
        throw new Error('Could not locate giri runtime files to bundle.');
    }

    return {
        name: 'giri-bundle',
        setup(pluginBuild) {
            // Root import re-exports the runtime plus defineConfig. Bundling dist/index.js would
            // pull the generator and TypeScript into the server artifact.
            pluginBuild.onResolve({ filter: /^@boon4681\/giri$/ }, () => ({
                path: GIRI_PACKAGE,
                namespace: 'giri-entry',
            }));
            pluginBuild.onLoad({ filter: /.*/, namespace: 'giri-entry' }, () => ({
                contents: [
                    `export { defineConfig } from ${JSON.stringify(slash(configFile))};`,
                    `export * from ${JSON.stringify(slash(runtimeFile))};`,
                ].join('\n'),
                loader: 'ts',
                resolveDir: giriPackageDir(),
            }));

            pluginBuild.onResolve({ filter: /.*/ }, (args) => {
                if (args.path.startsWith('.') || isAbsolute(args.path)) {
                    return undefined;
                }
                if (args.path.startsWith('$giri/')) {
                    return { path: join(giriOutDir, args.path.slice('$giri/'.length)) };
                }
                const aliased = resolveAliasRequest(args.path, alias, cwd);
                if (aliased) {
                    return { path: aliased };
                }
                const subpath = giriSubpath(args.path);
                if (subpath) {
                    const file = resolveGiriFile(subpath);
                    if (file) {
                        return { path: file };
                    }
                }
                return undefined;
            });
        },
    };
}

export async function buildProject(
    config: GiriConfig,
    options: BuildProjectOptions = {},
): Promise<BuildProjectResult> {
    const cwd = resolve(options.cwd ?? process.cwd());
    const paths = resolveGiriPaths(config, cwd);
    const outputDir = resolve(cwd, options.outDir ?? 'dist');
    for (const reserved of [paths.outDir, resolve(paths.routesDir, '..')]) {
        if (isWithin(reserved, outputDir)) {
            throw new Error(`Refusing to write the server bundle into ${reserved}. Choose another directory with --out.`);
        }
    }
    if (outputDir === cwd) {
        throw new Error('Refusing to write the server bundle into the project root. Choose another directory with --out.');
    }

    const configFile = findConfigPath(cwd);
    if (!configFile) {
        throw new Error('Config file not found.');
    }

    const routes = options.sync === false
        ? await scanRoutes(paths.routesDir)
        : (await syncProject(config, { cwd })).routes;
    const packageFormat = await outputFormat(cwd);
    const format = options.format ?? packageFormat;
    // Node picks the module system from package.json for `.js`, so a mismatched format needs its own extension.
    const extension = format === packageFormat ? '.js' : format === 'esm' ? '.mjs' : '.cjs';
    const outFile = join(outputDir, `index${extension}`);
    const contents = renderEntry(cwd, configFile, resolveMainFile(cwd), routes);

    await build({
        stdin: {
            contents,
            resolveDir: cwd,
            sourcefile: 'giri-build-entry.js',
            loader: 'js',
        },
        absWorkingDir: cwd,
        outfile: outFile,
        bundle: true,
        platform: 'node',
        format,
        target: 'es2022',
        packages: options.includeDeps ? 'bundle' : 'external',
        sourcemap: true,
        minify: options.minify ?? false,
        legalComments: 'none',
        logLevel: 'warning',
        // Installed giri ships CJS that require()s external packages; ESM output has no require.
        banner: {
            js: format === 'esm'
                ? [
                    '#!/usr/bin/env node',
                    "import { createRequire as __giriCreateRequire } from 'node:module';",
                    'const require = __giriCreateRequire(import.meta.url);',
                ].join('\n')
                : '#!/usr/bin/env node',
        },
        plugins: [bundlePlugin(cwd, config.alias, paths.outDir)],
    });

    return { outFile, routeCount: routes.length };
}

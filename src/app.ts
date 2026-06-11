import Module from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { safeRegister } from './loader/loader';
import { scanRoutes, type ScannedRoute } from './routes';
import type {
    GiriBodySchema,
    GiriConfig,
    GiriInputSchema,
    GiriPaths,
    GiriRouteRegistration,
    Handle,
    Middleware,
    RouteInput,
    Services,
} from './types';
import { isGiriBodySchema, isGiriInputSchema } from './validation';

export interface BuildGiriAppOptions {
    cwd?: string;
    services?: Services;
    /** Files that changed since last build — only these are purged from require.cache before loading. */
    dirty?: Set<string>;
    /** Defer route-module evaluation until the adapter first reads its runtime fields. */
    lazy?: boolean;
    /** The caller owns a persistent TypeScript loader for lazy route evaluation. */
    loaderRegistered?: boolean;
    /** The caller owns a persistent project-alias resolver for lazy route evaluation. */
    aliasResolverRegistered?: boolean;
}

export interface BuiltGiriApp<App> {
    app: App;
    routes: ScannedRoute[];
    paths: GiriPaths;
}

interface RouteModule {
    handle?: Handle;
    middleware?: Middleware | Middleware[];
    body?: unknown;
    query?: unknown;
    config?: {
        skipInherited?: boolean;
    };
}

function loadModule(file: string, force = true): unknown {
    const resolved = require.resolve(file);
    if (force) {
        delete require.cache[resolved];
    }
    return require(resolved);
}

function interopDefault(value: unknown): unknown {
    if (value && typeof value === 'object' && 'default' in value) {
        return (value as { default: unknown }).default;
    }
    return value;
}

function normalizeMiddleware(value: unknown, file: string): Middleware[] {
    const exported = interopDefault(value);
    if (exported === undefined) {
        return [];
    }
    if (typeof exported === 'function') {
        return [exported as Middleware];
    }
    if (Array.isArray(exported)) {
        for (const middleware of exported) {
            if (typeof middleware !== 'function') {
                throw new Error(`Middleware export in ${file} must contain only functions.`);
            }
        }
        return exported as Middleware[];
    }
    throw new Error(`Middleware export in ${file} must be a function or an array of functions.`);
}

function assertBodySchema(value: unknown, file: string): asserts value is GiriBodySchema {
    if (!isGiriBodySchema(value)) {
        throw new Error(
            `${file}: "body" must be wrapped with a validator, e.g. \`export const body = zod.body({ json: ... })\` from @boon4681/giri/validators/zod.`,
        );
    }
}

function assertQuerySchema(value: unknown, file: string): asserts value is GiriInputSchema {
    if (!isGiriInputSchema(value)) {
        throw new Error(
            `${file}: "query" must be wrapped with a validator, e.g. \`export const query = zod.query(...)\` from @boon4681/giri/validators/zod.`,
        );
    }
}

function routeInput(routeModule: RouteModule, file: string): RouteInput | undefined {
    const input: RouteInput = {};
    if (routeModule.body !== undefined) {
        assertBodySchema(routeModule.body, file);
        input.body = routeModule.body;
    }
    if (routeModule.query !== undefined) {
        assertQuerySchema(routeModule.query, file);
        input.query = routeModule.query;
    }
    return input.body || input.query ? input : undefined;
}

function aliasValues(value: string | string[]): string[] {
    return Array.isArray(value) ? value : [value];
}

function resolveAliasTarget(cwd: string, target: string, capture = ''): string {
    const replaced = target.includes('*') ? target.replaceAll('*', capture) : target;
    return isAbsolute(replaced) ? replaced : resolve(cwd, replaced);
}

function matchAlias(request: string, key: string): string | undefined {
    if (key.includes('*')) {
        const [prefix, suffix = ''] = key.split('*');
        if (request.startsWith(prefix) && request.endsWith(suffix)) {
            return request.slice(prefix.length, request.length - suffix.length);
        }
        return undefined;
    }
    
    return request === key ? '' : undefined;
}

export function resolveAliasRequest(
    request: string,
    alias: GiriConfig['alias'],
    cwd: string,
): string | undefined {
    for (const [key, value] of Object.entries(alias ?? {})) {
        const capture = matchAlias(request, key);
        if (capture === undefined) {
            continue;
        }

        const [target] = aliasValues(value);
        if (!target) {
            continue;
        }

        return resolveAliasTarget(cwd, target, capture);
    }

    return undefined;
}

export function registerAliasResolver(alias: GiriConfig['alias'], cwd: string): () => void {
    if (!alias || Object.keys(alias).length === 0) {
        return () => { };
    }

    const moduleWithResolver = Module as typeof Module & {
        _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
    };
    const originalResolveFilename = moduleWithResolver._resolveFilename;

    moduleWithResolver._resolveFilename = function resolveWithGiriAlias(
        request,
        parent,
        isMain,
        options,
    ) {
        return originalResolveFilename.call(
            this,
            resolveAliasRequest(request, alias, cwd) ?? request,
            parent,
            isMain,
            options,
        );
    };

    return () => {
        moduleWithResolver._resolveFilename = originalResolveFilename;
    };
}

const GIRI_ALIAS_PREFIX = '$giri/';
let giriOutDir: string | undefined;
let giriResolverInstalled = false;

/**
 * Install a process-lifetime resolver for the internal `$giri/*` alias
 */
export function ensureGiriAliasResolver(outDir: string): void {
    giriOutDir = outDir;
    if (giriResolverInstalled) {
        return;
    }
    giriResolverInstalled = true;

    const moduleWithResolver = Module as typeof Module & {
        _resolveFilename: (request: string, parent: unknown, isMain: boolean, options: unknown) => string;
    };
    const originalResolveFilename = moduleWithResolver._resolveFilename;

    moduleWithResolver._resolveFilename = function resolveWithGiriInternalAlias(
        request,
        parent,
        isMain,
        options,
    ) {
        const mapped =
            typeof request === 'string' && request.startsWith(GIRI_ALIAS_PREFIX) && giriOutDir
                ? join(giriOutDir, request.slice(GIRI_ALIAS_PREFIX.length))
                : request;
        return originalResolveFilename.call(this, mapped, parent, isMain, options);
    };
}

export function resolveGiriPaths(config: Pick<GiriConfig, 'outDir'>, cwd = process.cwd()): GiriPaths {
    return {
        cwd: resolve(cwd),
        routesDir: resolve(cwd, 'src/routes'),
        outDir: resolve(cwd, config.outDir ?? '.giri'),
    };
}

export async function buildGiriApp<App>(
    config: GiriConfig<App>,
    options: BuildGiriAppOptions = {},
): Promise<BuiltGiriApp<App>> {
    const paths = resolveGiriPaths(config, options.cwd);
    const routes = await scanRoutes(paths.routesDir);
    const app = config.adapter.createApp();
    // Install the persistent `$giri` resolver BEFORE esbuild-register: it patches
    // `_resolveFilename` too, and its unregister() restores whatever it captured
    ensureGiriAliasResolver(paths.outDir);
    if (options.lazy && (!options.loaderRegistered || !options.aliasResolverRegistered)) {
        throw new Error('Lazy route loading requires persistent loader and alias registrations.');
    }
    const loader = options.loaderRegistered ? undefined : await safeRegister();
    const unregisterAliasResolver = options.aliasResolverRegistered
        ? undefined
        : registerAliasResolver(config.alias, paths.cwd);

    try {
        const dirty = options.dirty;
        const forceReload = dirty === undefined;
        const isDirty = (file: string): boolean => forceReload || dirty.has(file);
        const sharedCache = new Map<string, unknown>();
        const loadShared = (file: string): unknown => {
            if (!sharedCache.has(file)) {
                sharedCache.set(file, loadModule(file, isDirty(file)));
            }
            return sharedCache.get(file);
        };

        const runtimeFor = (route: ScannedRoute): GiriRouteRegistration => {
            const routeModule = loadModule(route.file, isDirty(route.file)) as RouteModule;
            if (typeof routeModule.handle !== 'function') {
                throw new Error(`${route.file} must export a named handle function.`);
            }

            const folderMiddleware = routeModule.config?.skipInherited
                ? []
                : route.sharedFiles.flatMap((file) =>
                    normalizeMiddleware((loadShared(file) as { middleware?: unknown }).middleware, file),
                );
            const verbMiddleware = normalizeMiddleware(routeModule.middleware, route.file);

            return {
                method: route.method,
                path: route.path,
                handle: routeModule.handle,
                middleware: [...folderMiddleware, ...verbMiddleware],
                input: routeInput(routeModule, route.file),
                services: options.services,
                cookieSecret: config.cookieSecret,
            };
        };

        for (const route of routes) {
            if (!options.lazy) {
                config.adapter.register(app, runtimeFor(route));
                continue;
            }

            let runtime: GiriRouteRegistration | undefined;
            const getRuntime = (): GiriRouteRegistration => {
                runtime ??= runtimeFor(route);
                return runtime;
            };
            config.adapter.register(app, {
                method: route.method,
                path: route.path,
                get handle() {
                    return getRuntime().handle;
                },
                get middleware() {
                    return getRuntime().middleware;
                },
                get input() {
                    return getRuntime().input;
                },
                services: options.services,
                cookieSecret: config.cookieSecret,
            });
        }
    } finally {
        unregisterAliasResolver?.();
        loader?.unregister();
    }

    return { app, routes, paths };
}

import { registerAliasResolver } from '../app';
import { safeRegister } from '../loader/loader';
import type { ScannedRoute } from '../routes';
import type { GiriConfig, GiriPaths, Middleware, SecurityRequirement } from '../types';
import { bodyToJsonSchemas, inputToJsonSchema, type RouteInputSchemas } from './inputs';

export interface RouteSecurity {
    /** Operation-level `security` requirements, e.g. `[{ bearerAuth: [] }]`. */
    security: SecurityRequirement[];
    /** Scheme definitions to merge into `components.securitySchemes`. */
    securitySchemes: Record<string, unknown>;
}

export interface RouteMeta {
    input?: RouteInputSchemas;
    security?: RouteSecurity;
    /** Excluded from `openapi.json` (via `openapi`/`+shared.ts` resolution). */
    hidden?: boolean;
}

function loadModule(file: string): Record<string, unknown> {
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    return require(resolved) as Record<string, unknown>;
}

function interopDefault(value: unknown): unknown {
    if (value && typeof value === 'object' && 'default' in value) {
        return (value as { default: unknown }).default;
    }
    return value;
}

function middlewareFunctions(value: unknown): Middleware[] {
    const exported = interopDefault(value);
    if (typeof exported === 'function') {
        return [exported as Middleware];
    }
    if (Array.isArray(exported)) {
        return exported.filter((fn): fn is Middleware => typeof fn === 'function');
    }
    return [];
}

function readInput(routeModule: Record<string, unknown>): RouteInputSchemas | undefined {
    const input: RouteInputSchemas = {};
    const body = bodyToJsonSchemas(routeModule.body);
    const query = inputToJsonSchema(routeModule.query);
    if (body) {
        input.body = body;
    }
    if (query) {
        input.query = query;
    }
    return input.body || input.query ? input : undefined;
}

function hiddenFrom(value: unknown): boolean | undefined {
    if (value === false) {
        return true;
    }
    if (value === true) {
        return false;
    }
    if (value && typeof value === 'object' && 'hidden' in value) {
        return Boolean((value as { hidden?: unknown }).hidden);
    }
    return undefined; // no opinion
}

function collectHidden(
    route: ScannedRoute,
    routeModule: Record<string, unknown>,
    loadShared: (file: string) => Record<string, unknown>,
): boolean {
    let hidden = false;
    for (const file of route.sharedFiles) {
        const opinion = hiddenFrom(loadShared(file).openapi);
        if (opinion !== undefined) {
            hidden = opinion;
        }
    }
    const verb = hiddenFrom(routeModule.openapi);
    return verb ?? hidden;
}

function collectSecurity(
    route: ScannedRoute,
    routeModule: Record<string, unknown>,
    loadShared: (file: string) => Record<string, unknown>,
): RouteSecurity | undefined {
    const skipInherited = Boolean(
        (routeModule.config as { skipInherited?: boolean } | undefined)?.skipInherited,
    );

    const middleware: Middleware[] = [];
    if (!skipInherited) {
        for (const file of route.sharedFiles) {
            middleware.push(...middlewareFunctions(loadShared(file).middleware));
        }
    }
    middleware.push(...middlewareFunctions(routeModule.middleware));

    const security: SecurityRequirement[] = [];
    const securitySchemes: Record<string, unknown> = {};
    for (const fn of middleware) {
        const openapi = fn.openapi;
        if (openapi?.security) {
            for (const requirement of openapi.security) {
                if (!security.some((seen) => JSON.stringify(seen) === JSON.stringify(requirement))) {
                    security.push(requirement);
                }
            }
        }
        if (openapi?.securitySchemes) {
            Object.assign(securitySchemes, openapi.securitySchemes);
        }
    }

    return security.length > 0 || Object.keys(securitySchemes).length > 0
        ? { security, securitySchemes }
        : undefined;
}

/**
 * Load each route module once (with import aliases active) to derive runtime metadata:
 * input JSON Schemas from `body`/`query`, and OpenAPI `security` from the middleware
 * actually applied to the route (folder chain + verb, honoring `skipInherited`).
 */
export async function extractRouteMeta(
    config: Pick<GiriConfig, 'alias'>,
    paths: GiriPaths,
    routes: ScannedRoute[],
): Promise<Map<string, RouteMeta>> {
    const byFile = new Map<string, RouteMeta>();
    const { unregister } = await safeRegister();
    const unregisterAlias = registerAliasResolver(config.alias, paths.cwd);
    const sharedCache = new Map<string, Record<string, unknown>>();
    const loadShared = (file: string): Record<string, unknown> => {
        if (!sharedCache.has(file)) {
            try {
                sharedCache.set(file, loadModule(file));
            } catch {
                sharedCache.set(file, {});
            }
        }
        return sharedCache.get(file)!;
    };

    try {
        for (const route of routes) {
            try {
                const routeModule = loadModule(route.file);
                const meta: RouteMeta = {};
                const input = readInput(routeModule);
                const security = collectSecurity(route, routeModule, loadShared);
                const hidden = collectHidden(route, routeModule, loadShared);
                if (input) {
                    meta.input = input;
                }
                if (security) {
                    meta.security = security;
                }
                if (hidden) {
                    meta.hidden = true;
                }
                if (meta.input || meta.security || meta.hidden) {
                    byFile.set(route.file, meta);
                }
            } catch {
                // A route that fails to load just contributes no metadata.
            }
        }
    } finally {
        unregisterAlias();
        unregister();
    }

    return byFile;
}

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { registerAliasResolver } from '../app';
import { safeRegister } from '../loader/loader';
import type { ScannedRoute } from '../routes';
import type { GiriConfig, GiriPaths, Middleware, SecurityRequirement } from '../types';
import { resolveRouteInput, RouteInputError } from '../validation';
import { bodiesToJsonSchemas, queryToJsonSchema, type RouteInputSchemas } from './inputs';
import { parseRouteOpenApi } from './schema/route-openapi';

export interface RouteSecurity {
    /** Operation-level `security` requirements, e.g. `[{ bearerAuth: [] }]`. */
    security: SecurityRequirement[];
    /** Scheme definitions to merge into `components.securitySchemes`. */
    securitySchemes: Record<string, unknown>;
}

/** Resolved OpenAPI operation metadata (everything on `openapi` except `hidden`). */
export interface RouteOpenApiMeta {
    tags?: string[];
    summary?: string;
    description?: string;
    deprecated?: boolean;
    operationId?: string;
}

export interface RouteMeta {
    input?: RouteInputSchemas;
    security?: RouteSecurity;
    /** Excluded from `openapi.json` (via `openapi`/`+shared.ts` resolution). */
    hidden?: boolean;
    /** Operation metadata (tags/summary/…) resolved down the `+shared.ts` chain. */
    openapi?: RouteOpenApiMeta;
}

type StaticOpenApi =
    | boolean
    | {
        hidden?: boolean;
        tags?: string[];
        summary?: string;
        description?: string;
        deprecated?: boolean;
        operationId?: string;
    };

interface StaticModuleMeta {
    openapi?: StaticOpenApi;
    middlewareSecurity: boolean;
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

function readInput(
    routeModule: Record<string, unknown>,
    middleware: Middleware[],
    label: string,
): RouteInputSchemas | undefined {
    const resolved = resolveRouteInput([
        ...middleware.map((fn, index) => ({
            label: `${label} middleware[${index}]`,
            body: fn.body,
            query: fn.query,
        })),
        { label, body: routeModule.body, query: routeModule.query },
    ]);
    const input: RouteInputSchemas = {};
    const body = bodiesToJsonSchemas(resolved?.body);
    const query = queryToJsonSchema(resolved?.query);
    if (body) {
        input.body = body;
    }
    if (query) {
        input.query = query;
    }
    return input.body || input.query ? input : undefined;
}

function hasExportModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) &&
        (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function staticBoolean(expression: ts.Expression): boolean | undefined {
    const value = unwrapExpression(expression);
    if (value.kind === ts.SyntaxKind.TrueKeyword) {
        return true;
    }
    if (value.kind === ts.SyntaxKind.FalseKeyword) {
        return false;
    }
    return undefined;
}

function staticString(expression: ts.Expression): string | undefined {
    const value = unwrapExpression(expression);
    return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function staticStringArray(expression: ts.Expression): string[] | undefined {
    const value = unwrapExpression(expression);
    if (!ts.isArrayLiteralExpression(value)) {
        return undefined;
    }

    const strings: string[] = [];
    for (const element of value.elements) {
        const string = staticString(element);
        if (string === undefined) {
            return undefined;
        }
        strings.push(string);
    }
    return strings;
}

function propertyName(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    return undefined;
}

function collectImportedNames(source: ts.SourceFile): Set<string> {
    const names = new Set<string>();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) {
            continue;
        }
        const clause = statement.importClause;
        if (!clause) {
            continue;
        }
        if (clause.name) {
            names.add(clause.name.text);
        }
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
            names.add(bindings.name.text);
        }
        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                names.add(element.name.text);
            }
        }
    }
    return names;
}

function expressionReferencesImportedMiddleware(expression: ts.Expression, importedNames: Set<string>): boolean {
    let found = false;
    const allowedImportedHelpers = new Set(['stack', 'fromHono']);
    const visit = (node: ts.Node): void => {
        if (found) {
            return;
        }
        if (ts.isIdentifier(node) && importedNames.has(node.text) && !allowedImportedHelpers.has(node.text)) {
            found = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(expression);
    return found;
}

function parseStaticOpenApi(expression: ts.Expression): StaticOpenApi | undefined {
    const value = unwrapExpression(expression);
    const boolean = staticBoolean(value);
    if (boolean !== undefined) {
        return boolean;
    }
    if (!ts.isObjectLiteralExpression(value)) {
        return undefined;
    }

    const openapi: Exclude<StaticOpenApi, boolean> = {};
    for (const property of value.properties) {
        if (!ts.isPropertyAssignment(property)) {
            return undefined;
        }
        const name = propertyName(property.name);
        if (!name) {
            return undefined;
        }
        if (name === 'hidden') {
            const hidden = staticBoolean(property.initializer);
            if (hidden === undefined) {
                return undefined;
            }
            openapi.hidden = hidden;
        } else if (name === 'tags') {
            const tags = staticStringArray(property.initializer);
            if (!tags) {
                return undefined;
            }
            openapi.tags = tags;
        } else if (name === 'summary' || name === 'description' || name === 'operationId') {
            const string = staticString(property.initializer);
            if (string === undefined) {
                return undefined;
            }
            openapi[name] = string;
        } else if (name === 'deprecated') {
            const deprecated = staticBoolean(property.initializer);
            if (deprecated === undefined) {
                return undefined;
            }
            openapi.deprecated = deprecated;
        } else {
            return undefined;
        }
    }

    return openapi;
}

function readStaticModuleMeta(file: string): StaticModuleMeta | undefined {
    let source: ts.SourceFile;
    try {
        source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    } catch {
        return undefined;
    }

    const importedNames = collectImportedNames(source);
    const sourceText = source.getFullText();
    const canSkipMiddlewareRuntime =
        !sourceText.includes('defineMiddleware') &&
        !sourceText.includes('.openapi');
    const meta: StaticModuleMeta = { middlewareSecurity: false };
    for (const statement of source.statements) {
        if (
            ts.isImportDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEmptyStatement(statement) ||
            !hasExportModifier(statement)
        ) {
            continue;
        }

        if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'handle') {
            continue;
        }

        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) {
                    return undefined;
                }
                const name = declaration.name.text;
                if (name === 'openapi') {
                    if (!declaration.initializer) {
                        return undefined;
                    }
                    const openapi = parseStaticOpenApi(declaration.initializer);
                    if (openapi === undefined) {
                        return undefined;
                    }
                    meta.openapi = openapi;
                } else if (name === 'handle') {
                    if (
                        !declaration.initializer ||
                        (!ts.isArrowFunction(declaration.initializer) &&
                            !ts.isFunctionExpression(declaration.initializer))
                    ) {
                        return undefined;
                    }
                    continue;
                } else if (name === 'middleware') {
                    if (
                        !declaration.initializer ||
                        !canSkipMiddlewareRuntime ||
                        expressionReferencesImportedMiddleware(declaration.initializer, importedNames)
                    ) {
                        return undefined;
                    }
                    meta.middlewareSecurity = false;
                    continue;
                } else {
                    return undefined;
                }
            }
            continue;
        }

        return undefined;
    }

    return meta;
}

function resolveStaticOpenApi(route: ScannedRoute, routeModule: StaticModuleMeta, loadShared: (file: string) => StaticModuleMeta | undefined): { hidden: boolean; meta: RouteOpenApiMeta } | undefined {
    let hidden = false;
    const tags: string[] = [];
    const meta: RouteOpenApiMeta = {};

    const apply = (value: StaticOpenApi | undefined, isVerb: boolean): void => {
        if (value === false) {
            hidden = true;
            return;
        }
        if (value === true) {
            hidden = false;
            return;
        }
        if (!value) {
            return;
        }
        if (typeof value.hidden === 'boolean') {
            hidden = value.hidden;
        }
        if (value.tags) {
            tags.push(...value.tags);
        }
        if (typeof value.summary === 'string') {
            meta.summary = value.summary;
        }
        if (typeof value.description === 'string') {
            meta.description = value.description;
        }
        if (typeof value.deprecated === 'boolean') {
            meta.deprecated = value.deprecated;
        }
        if (isVerb && typeof value.operationId === 'string') {
            meta.operationId = value.operationId;
        }
    };

    for (const file of route.sharedFiles) {
        const shared = loadShared(file);
        if (!shared) {
            return undefined;
        }
        apply(shared.openapi, false);
    }
    apply(routeModule.openapi, true);

    if (tags.length > 0) {
        meta.tags = [...new Set(tags)];
    }
    return { hidden, meta };
}

function extractStaticMeta(
    route: ScannedRoute,
    routeModule: StaticModuleMeta,
    loadShared: (file: string) => StaticModuleMeta | undefined,
): RouteMeta | undefined {
    const openapi = resolveStaticOpenApi(route, routeModule, loadShared);
    if (!openapi) {
        return undefined;
    }

    const meta: RouteMeta = {};
    if (openapi.hidden) {
        meta.hidden = true;
    }
    if (Object.keys(openapi.meta).length > 0) {
        meta.openapi = openapi.meta;
    }
    return meta;
}

function extractRuntimeSharedMeta(
    route: ScannedRoute,
    routeModule: StaticModuleMeta,
    loadShared: (file: string) => Record<string, unknown>,
): RouteMeta {
    const meta: RouteMeta = {};
    const middleware = collectMiddleware(route, {}, loadShared);
    const input = readInput({}, middleware, route.file);
    const security = collectSecurity(route, {}, loadShared);
    const { hidden, meta: openapi } = resolveOpenApi(route, { openapi: routeModule.openapi }, loadShared);
    if (input) {
        meta.input = input;
    }
    if (security) {
        meta.security = security;
    }
    if (hidden) {
        meta.hidden = true;
    }
    if (Object.keys(openapi).length > 0) {
        meta.openapi = openapi;
    }
    return meta;
}

/**
 * Resolve the `openapi` export down a route's `+shared.ts` chain. `tags` are
 * merged and de-duplicated so a folder groups its routes; scalar fields (summary/description/
 * deprecated) override (verb wins); `operationId` is taken only from the verb file.
 */
function resolveOpenApi(
    route: ScannedRoute,
    routeModule: Record<string, unknown>,
    loadShared: (file: string) => Record<string, unknown>,
): { hidden: boolean; meta: RouteOpenApiMeta } {
    let hidden = false;
    const tags: string[] = [];
    const meta: RouteOpenApiMeta = {};

    const apply = (value: unknown, isVerb: boolean): void => {
        if (value === false) {
            hidden = true;
            return;
        }
        if (value === true) {
            hidden = false;
            return;
        }
        const parsed = parseRouteOpenApi(value);
        if (!parsed) {
            return;
        }
        if (parsed.hidden !== undefined) {
            hidden = parsed.hidden;
        }
        if (parsed.tags) {
            tags.push(...parsed.tags);
        }
        if (parsed.summary !== undefined) {
            meta.summary = parsed.summary;
        }
        if (parsed.description !== undefined) {
            meta.description = parsed.description;
        }
        if (parsed.deprecated !== undefined) {
            meta.deprecated = parsed.deprecated;
        }
        if (isVerb && parsed.operationId !== undefined) {
            meta.operationId = parsed.operationId;
        }
    };

    for (const file of route.sharedFiles) {
        apply(loadShared(file).openapi, false);
    }
    apply(routeModule.openapi, true);

    if (tags.length > 0) {
        meta.tags = [...new Set(tags)];
    }
    return { hidden, meta };
}

function collectSecurity(
    route: ScannedRoute,
    routeModule: Record<string, unknown>,
    loadShared: (file: string) => Record<string, unknown>,
): RouteSecurity | undefined {
    const middleware = collectMiddleware(route, routeModule, loadShared);
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

function collectMiddleware(
    route: ScannedRoute,
    routeModule: Record<string, unknown>,
    loadShared: (file: string) => Record<string, unknown>,
): Middleware[] {
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
    return middleware;
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
    const remainingRoutes: ScannedRoute[] = [];
    const runtimeSharedRoutes: { route: ScannedRoute; routeModule: StaticModuleMeta }[] = [];
    const staticCache = new Map<string, StaticModuleMeta | undefined>();
    const loadStatic = (file: string): StaticModuleMeta | undefined => {
        if (!staticCache.has(file)) {
            staticCache.set(file, readStaticModuleMeta(file));
        }
        return staticCache.get(file);
    };

    for (const route of routes) {
        const routeModule = loadStatic(route.file);
        if (!routeModule) {
            remainingRoutes.push(route);
            continue;
        }
        const meta = extractStaticMeta(route, routeModule, loadStatic);
        if (meta) {
            if (meta.hidden || meta.openapi) {
                byFile.set(route.file, meta);
            }
            continue;
        }
        runtimeSharedRoutes.push({ route, routeModule });
    }

    if (remainingRoutes.length === 0 && runtimeSharedRoutes.length === 0) {
        return byFile;
    }

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
        for (const { route, routeModule } of runtimeSharedRoutes) {
            const meta = extractRuntimeSharedMeta(route, routeModule, loadShared);
            if (meta.input || meta.security || meta.hidden || meta.openapi) {
                byFile.set(route.file, meta);
            }
        }
        for (const route of remainingRoutes) {
            try {
                const routeModule = loadModule(route.file);
                const meta: RouteMeta = {};
                const middleware = collectMiddleware(route, routeModule, loadShared);
                const input = readInput(routeModule, middleware, route.file);
                const security = collectSecurity(route, routeModule, loadShared);
                const { hidden, meta: openapi } = resolveOpenApi(route, routeModule, loadShared);
                if (input) {
                    meta.input = input;
                }
                if (security) {
                    meta.security = security;
                }
                if (hidden) {
                    meta.hidden = true;
                }
                if (Object.keys(openapi).length > 0) {
                    meta.openapi = openapi;
                }
                if (meta.input || meta.security || meta.hidden || meta.openapi) {
                    byFile.set(route.file, meta);
                }
            } catch (error) {
                // A validator conflict is an actionable config error (the same one the app throws
                // at boot) - surface it instead of silently dropping the route's metadata. A plain
                // load failure just contributes no metadata.
                if (error instanceof RouteInputError) {
                    throw error;
                }
            }
        }
    } finally {
        unregisterAlias();
        unregister();
    }

    return byFile;
}

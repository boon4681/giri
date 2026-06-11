import { serve as serveNode } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context as HonoContext, ContextVariableMap, MiddlewareHandler } from 'hono';
import { parse, parseSigned, serialize, serializeSigned } from 'hono/utils/cookie';
import {
    composeMiddleware,
    createContext,
    isTypedResponse,
    toResponse,
    typedResponseToResponse,
} from '../context';
import { log } from '../logger';
import { nativeContextBrand } from '../types';
import type {
    Context as GiriContext,
    CookieJarFactory,
    GiriAdapter,
    GiriRouteRegistration,
    Middleware,
    ValidatedInput,
} from '../types';
import { prepareRequestInput } from '../validation';

const honoCookieJar: CookieJarFactory = ({ request, append, secret }) => {
    const header = request.headers.get('cookie') ?? '';
    const requireSecret = (): string => {
        if (!secret) {
            throw new Error('Signed cookies require `cookieSecret` in giri.config.');
        }
        return secret;
    };

    return {
        get: (name) => parse(header, name)[name],
        all: () => parse(header),
        set: (name, value, options) => append(serialize(name, value, options)),
        delete: (name, options) =>
            append(serialize(name, '', { ...options, maxAge: 0, expires: new Date(0) })),
        getSigned: async (name) => (await parseSigned(header, requireSecret(), name))[name],
        setSigned: async (name, value, options) =>
            append(await serializeSigned(name, value, requireSecret(), options)),
    };
};

export type HonoGiriApp = Hono;
export type HonoContextVars = { [K in keyof ContextVariableMap]: ContextVariableMap[K] };

type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * The `Variables` a single Hono middleware declares on its own `Env` (`MiddlewareHandler<{ Variables }>`).
 * This is Hono's *scoped* var typing - unlike the global `ContextVariableMap`, it travels with the
 * handler. A handler with no typed Variables (e.g. `cors()`, whose `Env` is `any`) contributes `{}`.
 */
type HonoHandlerVars<H> = H extends MiddlewareHandler<infer E>
    ? E extends { Variables: infer V }
        ? IsAny<V> extends true
            ? {}
            : V extends Record<string, unknown>
                ? V
                : {}
        : {}
    : {};

/** Intersect the scoped Variables of every handler passed to `fromHono`. */
type MergeHandlerVars<H extends readonly unknown[]> = H extends readonly [infer Head, ...infer Tail]
    ? HonoHandlerVars<Head> & MergeHandlerVars<Tail>
    : {};

async function routeHandler(honoContext: HonoContext, route: GiriRouteRegistration): Promise<Response> {
    try {
        const prepared = await prepareRequestInput(honoContext.req.raw, route.input);
        if (!prepared.ok) {
            return toResponse(prepared.response);
        }

        const context = createContext({
            request: honoContext.req.raw,
            params: honoContext.req.param() as Record<string, string>,
            validated: prepared.validated,
            app: route.services,
            native: honoContext,
            cookieSecret: route.cookieSecret,
            cookies: honoCookieJar,
        });
        const result = await composeMiddleware(route.middleware, route.handle, context);
        return toResponse(result, context);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.error(`${route.method} ${route.path} - ${err.message}`, 'request');
        console.error(err.stack ?? err);
        return new Response('Internal Server Error', { status: 500 });
    }
}

function syncHonoVars(honoContext: HonoContext, giriContext: GiriContext): void {
    const vars = honoContext.var as Record<string, unknown> | undefined;
    if (!vars) {
        return;
    }
    for (const key of Object.keys(vars)) {
        giriContext.set(key, vars[key]);
    }
}

/**
 * Wrap one or more native Hono middleware as a single giri `Middleware`, so the existing Hono
 * ecosystem (`@hono/oauth-providers`, CORS, etc.) runs unchanged on a giri route:
 *
 * ```ts
 * // routes/auth/google/+shared.ts
 * import { fromHono } from "@boon4681/giri/adapters/hono";
 * import { googleAuth } from "@hono/oauth-providers/google";
 *
 * export const middleware = stack(
 *   fromHono(googleAuth({ client_id: …, scope: ["openid"] })),
 * );
 * // downstream handler (only under this folder): const user = c.get("user-google");
 * ```
 *
 * It runs the Hono middleware against the real Hono context (cookies, `c.redirect`, `c.req.query`
 * all work), then mirrors any vars it set onto giri's `c` for downstream `c.get`. Only valid on the
 * Hono adapter - throws on any other backend.
 *
 * Vars are inferred from each handler's own `Env["Variables"]` (Hono's scoped var typing), so a
 * middleware typed `MiddlewareHandler<{ Variables: { … } }>` types `c.get` automatically, scoped to
 * this folder's chain. A bare `cors()` (whose `Env` is `any`) contributes nothing.
 *
 * The inference deliberately does NOT read Hono's global `ContextVariableMap`: plugins augment that
 * map process-wide (e.g. `@hono/oauth-providers` adds `user-google`), so reading it would leak every
 * plugin's vars onto every route carrying any `fromHono` middleware. For such plugins (their handler
 * is a bare `MiddlewareHandler`), pass the vars explicitly: `fromHono<{ "user-google": GoogleUser }>(…)`.
 * Use `fromHono<HonoContextVars>(…)` to opt into the whole global map.
 */
export function fromHono<
    Vars extends Record<string, unknown> = never,
    H extends MiddlewareHandler[] = MiddlewareHandler[],
>(
    ...handlers: H
): Middleware<Record<string, string>, ValidatedInput, [Vars] extends [never] ? MergeHandlerVars<H> : Vars> {
    if (handlers.length === 0) {
        throw new Error('fromHono() requires at least one Hono middleware.');
    }

    return async (c, giriNext) => {
        const honoContext = (c as unknown as Record<symbol, unknown>)[nativeContextBrand] as
            | HonoContext
            | undefined;
        if (!honoContext) {
            throw new Error(
                'fromHono() can only run on the Hono adapter - no native Hono context found on the giri context.',
            );
        }

        const tail = async (): Promise<void> => {
            syncHonoVars(honoContext, c);
            const result = await giriNext();
            if (result instanceof Response) {
                honoContext.res = result;
            } else if (isTypedResponse(result)) {
                honoContext.res = typedResponseToResponse(result);
            }
        };

        const dispatch = (index: number): Promise<unknown> => {
            const handler = handlers[index];
            if (!handler) {
                return tail();
            }
            return Promise.resolve(handler(honoContext, () => dispatch(index + 1) as Promise<void>));
        };

        const returned = await dispatch(0);
        syncHonoVars(honoContext, c);
        return returned instanceof Response ? returned : honoContext.res;
    };
}

function registerHonoRoute(app: Hono, route: GiriRouteRegistration): void {
    type HonoHandler = (c: HonoContext) => Promise<Response>;

    const handler: HonoHandler = (c) => routeHandler(c, route);
    const method = route.method.toLowerCase();
    const appMethods = app as never as Record<string, (path: string, handler: HonoHandler) => void>;

    if (method in app && typeof appMethods[method] === 'function') {
        appMethods[method](route.path, handler);
        return;
    }

    throw new Error(`Hono adapter does not support ${route.method}.`);
}

export function hono(): GiriAdapter<HonoGiriApp> {
    return {
        name: 'hono',
        createApp: () => new Hono({ strict: false }),
        register: registerHonoRoute,
        fetch: async (app, req) => app.fetch(req),
        serve: (handler, options, onListen) => {
            const server = serveNode(
                {
                    fetch: handler,
                    port: options.port,
                    hostname: options.hostname,
                },
                onListen ? (info) => onListen({ address: info.address, port: info.port }) : undefined,
            );

            return {
                close: () => {
                    return new Promise<void>((resolve, reject) => {
                        server.close((error) => (error ? reject(error) : resolve()));
                    })
                }
            };
        },
    };
}

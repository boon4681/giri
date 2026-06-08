import { serve as serveNode } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context as HonoContext, ContextVariableMap, MiddlewareHandler } from 'hono';
import {
    composeMiddleware,
    createContext,
    isTypedResponse,
    toResponse,
    typedResponseToResponse,
} from '../context';
import { nativeContextBrand } from '../types';
import type {
    Context as GiriContext,
    GiriAdapter,
    GiriRouteRegistration,
    Middleware,
    ValidatedInput,
} from '../types';
import { prepareRequestInput } from '../validation';

export type HonoGiriApp = Hono;
export type HonoContextVars = { [K in keyof ContextVariableMap]: ContextVariableMap[K] };

async function routeHandler(honoContext: HonoContext, route: GiriRouteRegistration): Promise<Response> {
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
    });
    const result = await composeMiddleware(route.middleware, route.handle, context);
    return toResponse(result, context);
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
 *   fromHono(googleAuth({ client_id: …, client_secret: …, scope: ["openid", "email"] })),
 * );
 * // downstream handler: const user = c.get("user-google");
 * ```
 *
 * It runs the Hono middleware against the real Hono context (cookies, `c.redirect`, `c.req.query`
 * all work), then mirrors any vars it set onto giri's `c` for downstream `c.get`. Only valid on the
 * Hono adapter - throws on any other backend.
 */
export function fromHono<Vars extends Record<string, unknown> = HonoContextVars>(
    ...handlers: MiddlewareHandler[]
): Middleware<Record<string, string>, ValidatedInput, Vars> {
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

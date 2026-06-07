import { serve as serveNode } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context as HonoContext } from 'hono';
import { composeMiddleware, createContext, toResponse } from '../context';
import type { GiriAdapter, GiriRouteRegistration } from '../types';
import { prepareRequestInput } from '../validation';

export type HonoGiriApp = Hono;

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
    });
    const result = await composeMiddleware(route.middleware, route.handle, context);
    return toResponse(result);
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

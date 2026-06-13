import {
    type CookieJar,
    type CookieJarFactory,
    type Services,
    type Context,
    type HandlerResponse,
    type GiriBodySchema,
    type GiriInputSchema,
    type Middleware,
    type MiddlewareOptions,
    type MiddlewareOptionsInput,
    type ResponseFormat,
    type StatusCode,
    type TypedResponse,
    type ValidatedInput,
    nativeContextBrand,
    typedResponseBrand,
} from './types';

const BODYLESS_STATUS = new Set([101, 103, 204, 205, 304]);

/** Imperative response state set via `c.header()` / `c.status()`, merged in `toResponse`. */
interface PendingResponse {
    headers: Headers;
    status?: StatusCode;
}

const pendingResponseBrand: unique symbol = Symbol('giri.pending-response');

function getPending(context: Context): PendingResponse | undefined {
    return (context as unknown as Record<symbol, PendingResponse | undefined>)[pendingResponseBrand];
}

/** Used when the active adapter provides no cookie jar; every cookie call throws. */
const unsupportedCookieJar: CookieJar = {
    get: cookiesUnsupported,
    all: cookiesUnsupported,
    set: cookiesUnsupported,
    delete: cookiesUnsupported,
    getSigned: cookiesUnsupported,
    setSigned: cookiesUnsupported,
};

function cookiesUnsupported(): never {
    throw new Error('The active adapter does not support cookies.');
}

export interface CreateContextOptions<
    Params extends Record<string, string> = Record<string, string>,
    Input extends ValidatedInput = ValidatedInput,
> {
    request: Request;
    params?: Params;
    validated?: Input;
    app?: Services;
    /** The adapter's native per-request context, stashed for backend-specific bridges. */
    native?: unknown;
    /** Secret for `c.signedCookie` / `c.req.signedCookie` (from `config.cookieSecret`). */
    cookieSecret?: string;
    /** The adapter's cookie jar, built from its runtime's native helpers. */
    cookies?: CookieJarFactory;
}

export function createTypedResponse<
    T,
    S extends StatusCode,
    F extends ResponseFormat,
>(data: T, status: S, format: F, headers?: HeadersInit): TypedResponse<T, S, F> {
    return {
        [typedResponseBrand]: { data, status, format },
        data,
        status,
        format,
        headers,
    };
}

export function isTypedResponse(value: unknown): value is TypedResponse<unknown> {
    return Boolean(value && typeof value === 'object' && typedResponseBrand in value);
}

export function createContext<
    Params extends Record<string, string> = Record<string, string>,
    Input extends ValidatedInput = ValidatedInput,
>(options: CreateContextOptions<Params, Input>): Context<Params, Input> {
    const url = new URL(options.request.url);
    const store = new Map<string, unknown>();
    const validated = options.validated ?? ({} as Input);

    // Headers/status set imperatively via c.header()/c.status(); merged into the final response.
    const pending: PendingResponse = { headers: new Headers() };
    const defaultStatus = (): StatusCode => pending.status ?? 200;

    // Cookies are a runtime concern: the adapter owns reading/encoding/signing via its native
    // helpers. Core only hands it the sink (request in, Set-Cookie onto the pending response).
    // No adapter jar => cookies aren't supported, and using them throws.
    const cookies: CookieJar = options.cookies
        ? options.cookies({
              request: options.request,
              append: (header) => pending.headers.append('set-cookie', header),
              secret: options.cookieSecret,
          })
        : unsupportedCookieJar;

    const context: Context<Params, Input> = {
        params: options.params ?? ({} as Params),
        app: options.app ?? ({} as Services),
        req: {
            raw: options.request,
            url,
            method: options.request.method,
            header: (name) => options.request.headers.get(name),
            json: <T = unknown>() => options.request.json() as Promise<T>,
            text: () => options.request.text(),
            arrayBuffer: () => options.request.arrayBuffer(),
            formData: () => options.request.formData(),
            valid: (key) => {
                if (!(key in validated)) {
                    throw new Error(`No validated ${String(key)} data is available for this route.`);
                }
                return validated[key];
            },
            cookie: (name) => cookies.get(name),
            cookies: () => cookies.all(),
            signedCookie: (name) => cookies.getSigned(name),
        },
        set: (key: string, value: unknown) => {
            store.set(key, value);
        },
        get: (key: string) => store.get(key) as never,
        json: (data, status, headers) =>
            createTypedResponse(data, (status ?? defaultStatus()) as never, 'json', headers),
        text: (text, status, headers) =>
            createTypedResponse(text, (status ?? defaultStatus()) as never, 'text', headers),
        html: (html, status, headers) =>
            createTypedResponse(html, (status ?? defaultStatus()) as never, 'html', headers),
        body: (data, status, headers) =>
            new Response(data, { status: status ?? defaultStatus(), headers }),
        newResponse: (data, status, headers) =>
            new Response(data, { status: status ?? defaultStatus(), headers }),
        redirect: (location, status) =>
            new Response(null, { status: status ?? 302, headers: { Location: location } }),
        notFound: () => new Response('404 Not Found', { status: 404 }),
        header: (name, value, options) => {
            if (value === undefined) {
                pending.headers.delete(name);
            } else if (options?.append) {
                pending.headers.append(name, value);
            } else {
                pending.headers.set(name, value);
            }
        },
        status: (code) => {
            pending.status = code;
        },
        cookie: (name, value, options) => {
            if (value === null) {
                cookies.delete(name, options);
            } else {
                cookies.set(name, value, options);
            }
        },
        signedCookie: (name, value, options) => cookies.setSigned(name, value, options),
    };

    (context as unknown as Record<symbol, unknown>)[nativeContextBrand] = options.native;
    (context as unknown as Record<symbol, unknown>)[pendingResponseBrand] = pending;

    return context;
}

export function typedResponseToResponse(response: TypedResponse<unknown>): Response {
    const headers = new Headers(response.headers);

    if (response.format === 'json' && !headers.has('content-type')) {
        headers.set('content-type', 'application/json; charset=utf-8');
    }

    if (response.format === 'text' && !headers.has('content-type')) {
        headers.set('content-type', 'text/plain; charset=utf-8');
    }

    if (response.format === 'html' && !headers.has('content-type')) {
        headers.set('content-type', 'text/html; charset=utf-8');
    }

    const body = BODYLESS_STATUS.has(response.status)
        ? null
        : response.format === 'json'
            ? JSON.stringify(response.data)
            : String(response.data);

    return new Response(body, {
        status: response.status,
        headers,
    });
}

/**
 * Convert a handler's return value to a real `Response`, then merge any headers set imperatively via
 * `c.header()` (the response's own headers win; pending ones fill the gaps). Pass the `context` so
 * those imperative headers are applied; without it the response is returned unchanged.
 */
export function toResponse(response: HandlerResponse, context?: Context): Response {
    const base = isTypedResponse(response) ? typedResponseToResponse(response) : response;
    const pending = context ? getPending(context) : undefined;
    if (!pending) {
        return base;
    }

    let hasPending = false;
    pending.headers.forEach(() => {
        hasPending = true;
    });
    if (!hasPending) {
        return base;
    }

    const headers = new Headers(base.headers);
    pending.headers.forEach((value, key) => {
        // Set-Cookie is multi-valued; forEach coalesces it into one comma-joined string, so
        // handle it separately below to keep each cookie its own header.
        if (key === 'set-cookie') {
            return;
        }
        if (!headers.has(key)) {
            headers.set(key, value);
        }
    });
    for (const cookie of pending.headers.getSetCookie?.() ?? []) {
        headers.append('set-cookie', cookie);
    }
    return new Response(base.body, { status: base.status, statusText: base.statusText, headers });
}

export async function composeMiddleware(
    middleware: Middleware[],
    handle: (c: Context) => HandlerResponse | Promise<HandlerResponse>,
    context: Context,
): Promise<HandlerResponse> {
    let index = -1;
    let result: HandlerResponse | undefined;

    const dispatch = async (i: number): Promise<HandlerResponse | void> => {
        if (i <= index) {
            throw new Error('next() called multiple times in giri middleware.');
        }
        index = i;

        if (i === middleware.length) {
            result = await handle(context);
            return result;
        }

        const returned = await middleware[i](context, () => dispatch(i + 1));
        if (returned !== undefined) {
            result = returned;
            return returned;
        }
        return result;
    };

    await dispatch(0);

    if (result === undefined) {
        throw new Error('Route completed without returning a response.');
    }

    return result;
}

type AnyMiddleware<Vars extends Record<string, unknown>> = Middleware<
    Record<string, string>,
    ValidatedInput,
    Vars
>;

type MiddlewareMetadata<Options extends MiddlewareOptions> =
    ('body' extends keyof Options ? { readonly body: Options['body'] & GiriBodySchema } : {}) &
    ('query' extends keyof Options ? { readonly query: Options['query'] & GiriInputSchema } : {});

type DefinedMiddleware<
    Options extends MiddlewareOptions,
    Vars extends Record<string, unknown>,
> = Middleware<Record<string, string>, MiddlewareOptionsInput<Options>, Vars> &
    MiddlewareMetadata<Options>;

export function defineMiddleware<Vars extends Record<string, unknown> = {}>(
    middleware: AnyMiddleware<Vars>,
): AnyMiddleware<Vars>;
export function defineMiddleware<const Options extends MiddlewareOptions>(
    options: Options,
    middleware: Middleware<Record<string, string>, MiddlewareOptionsInput<Options>, {}>,
): DefinedMiddleware<Options, {}>;
export function defineMiddleware<
    Vars extends Record<string, unknown>,
    const Options extends MiddlewareOptions,
>(
    options: Options,
    middleware: Middleware<Record<string, string>, MiddlewareOptionsInput<Options>, Vars>,
): DefinedMiddleware<Options, Vars>;
export function defineMiddleware<Vars extends Record<string, unknown> = {}>(
    options: MiddlewareOptions & { body?: never; query?: never },
    middleware: AnyMiddleware<Vars>,
): AnyMiddleware<Vars>;
export function defineMiddleware(
    optionsOrMiddleware: MiddlewareOptions | Middleware,
    maybeMiddleware?: Middleware,
): Middleware {
    if (typeof optionsOrMiddleware === 'function') {
        return optionsOrMiddleware;
    }

    if (!maybeMiddleware) {
        throw new Error('defineMiddleware(options, middleware) requires a middleware function.');
    }

    maybeMiddleware.body = optionsOrMiddleware.body;
    maybeMiddleware.query = optionsOrMiddleware.query;
    maybeMiddleware.openapi = optionsOrMiddleware.openapi;
    return maybeMiddleware;
}

/**
 * Group middleware into an ordered stack, preserving each element's type as a tuple so
 * the injected context vars (`defineMiddleware<Vars>` / `Middleware<…, Vars>`) propagate
 * to downstream handlers. Use it for `+shared.ts` and verb `middleware` exports:
 * `export const middleware = stack(auth, requireAdmin)`.
 */
// Input and Vars are contravariant because they sit in the callback's context parameter.
// Keep both open so middleware with validator-owned input and injected vars can share a stack.
export function stack<T extends Middleware<any, any, any>[]>(...middleware: T): T {
    return middleware;
}

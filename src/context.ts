import {
    type Services,
    type Context,
    type HandlerResponse,
    type Middleware,
    type MiddlewareOptions,
    type ResponseFormat,
    type StatusCode,
    type TypedResponse,
    type ValidatedInput,
    nativeContextBrand,
    typedResponseBrand,
} from './types';

const BODYLESS_STATUS = new Set([101, 103, 204, 205, 304]);

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
        },
        set: (key: string, value: unknown) => {
            store.set(key, value);
        },
        get: (key: string) => store.get(key) as never,
        json: (data, status = 200 as never, headers) =>
            createTypedResponse(data, status, 'json', headers),
        text: (text, status = 200 as never, headers) =>
            createTypedResponse(text, status, 'text', headers),
    };
    
    (context as unknown as Record<symbol, unknown>)[nativeContextBrand] = options.native;

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

export function toResponse(response: HandlerResponse): Response {
    return isTypedResponse(response) ? typedResponseToResponse(response) : response;
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

export function defineMiddleware<Vars extends Record<string, unknown> = {}>(
    middleware: AnyMiddleware<Vars>,
): AnyMiddleware<Vars>;
export function defineMiddleware<Vars extends Record<string, unknown> = {}>(
    options: MiddlewareOptions,
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

    maybeMiddleware.openapi = optionsOrMiddleware.openapi;
    return maybeMiddleware;
}

/**
 * Group middleware into an ordered stack, preserving each element's type as a tuple so
 * the injected context vars (`defineMiddleware<Vars>` / `Middleware<…, Vars>`) propagate
 * to downstream handlers. Use it for `+shared.ts` and verb `middleware` exports:
 * `export const middleware = stack(auth, requireAdmin)`.
 */
// `Vars` is contravariant (it sits in the `c` parameter), so the constraint must leave it
// open (`any`) otherwise a middleware that injects vars isn't assignable to the element type.
export function stack<T extends Middleware<Record<string, string>, ValidatedInput, any>[]>(...middleware: T): T {
    return middleware;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

export type StatusCode = number;

export type ResponseFormat = 'json' | 'text';

export const typedResponseBrand: unique symbol = Symbol.for('giri.typed-response') as never;
export const nativeContextBrand: unique symbol = Symbol.for('giri.native-context') as never;

export interface TypedResponse<
    T,
    S extends StatusCode = StatusCode,
    F extends ResponseFormat = ResponseFormat,
> {
    readonly [typedResponseBrand]: {
        data: T;
        status: S;
        format: F;
    };
    readonly data: T;
    readonly status: S;
    readonly format: F;
    readonly headers?: HeadersInit;
}

export type HandlerResponse = Response | TypedResponse<unknown, StatusCode, ResponseFormat>;

export interface ValidatedInput {
    /**
     * The validated request body. For a single declared content-type it's that schema's
     * output; for several it's a discriminated union `{ type; data }` (see `ValidBody`).
     */
    body?: unknown;
    query?: unknown;
}

export interface GiriRequest<Input extends ValidatedInput = ValidatedInput> {
    raw: Request;
    url: URL;
    method: string;
    header(name: string): string | null;
    json<T = unknown>(): Promise<T>;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    formData(): Promise<FormData>;
    valid<K extends keyof Input & ('body' | 'query')>(key: K): Input[K];
}

declare global {
    /**
     * Global registration surface for app-wide types. `giri sync` augments
     * `Giri.Register["app"]` from `src/main.ts` `init()` return type so `c.app` is
     * typed without per-route generics (the registration pattern).
     */
    namespace Giri {
        interface Register {}
    }
}

/**
 * The app-wide services container, the type of `c.app`. `giri sync` infers it from
 * `src/main.ts`'s `init()` return type (via the global `Giri.Register` augmentation);
 * until then it falls back to an open record. Leave `init` unannotated (its return is
 * the source of truth) and annotate `teardown`'s parameter with this:
 *
 * ```ts
 * export const init = () => ({ db });            // inferred
 * export const teardown = (services: Services) => services.db.close();
 * ```
 */
export type Services = Giri.Register extends { app: infer A }
    ? A
    : Record<string, unknown>;

export interface Context<
    Params extends Record<string, string> = Record<string, string>,
    Input extends ValidatedInput = ValidatedInput,
    Vars extends Record<string, unknown> = {},
> {
    params: Params;
    /** App-wide services from `src/main.ts`'s `init()`, seeded into every request. */
    app: Services;
    req: GiriRequest<Input>;
    // Context vars (`c.set`/`c.get`). Keys declared by middleware (`Vars`) are typed;
    // any other key stays open (`unknown`) so untracked keys still work.
    set<K extends keyof Vars & string>(key: K, value: Vars[K]): void;
    set<K extends string>(key: K, value: unknown): void;
    get<K extends keyof Vars & string>(key: K): Vars[K];
    get<V = unknown>(key: string): V;
    json<T, S extends StatusCode = 200>(
        data: T,
        status?: S,
        headers?: HeadersInit,
    ): TypedResponse<T, S, 'json'>;
    text<S extends StatusCode = 200>(
        text: string,
        status?: S,
        headers?: HeadersInit,
    ): TypedResponse<string, S, 'text'>;
}

export type Handle<
    Params extends Record<string, string> = Record<string, string>,
    Input extends ValidatedInput = ValidatedInput,
    Vars extends Record<string, unknown> = {},
> = (c: Context<Params, Input, Vars>) => HandlerResponse | Promise<HandlerResponse>;

export type Next = () => Promise<HandlerResponse | void>;

/** An OpenAPI security requirement, e.g. `{ bearerAuth: [] }`. */
export type SecurityRequirement = Record<string, string[]>;

export interface MiddlewareOpenApi {
    /** Security requirements this middleware enforces */
    security?: SecurityRequirement[];
    /** Optional scheme definitions, merged into `components.securitySchemes` so the doc is self-contained. */
    securitySchemes?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface MiddlewareOptions {
    openapi?: MiddlewareOpenApi;
}

export interface Middleware<
    Params extends Record<string, string> = Record<string, string>,
    Input extends ValidatedInput = ValidatedInput,
    Vars extends Record<string, unknown> = {},
> {
    (c: Context<Params, Input, Vars>, next: Next): HandlerResponse | void | Promise<HandlerResponse | void>;
    openapi?: MiddlewareOpenApi;
}

/** The context vars a middleware injects (its `Vars` type parameter). */
export type VarsOf<M> = M extends Middleware<Record<string, string>, ValidatedInput, infer V>
    ? V
    : {};

/** Intersect the injected vars of a tuple of middleware (built with `stack(...)`). */
export type MergeStack<T> = T extends readonly [infer Head, ...infer Rest]
    ? VarsOf<Head> & MergeStack<Rest>
    : {};

/**
 * Merge the injected vars of a `middleware` export. A `stack(...)` tuple is merged element-wise;
 * a single bare middleware (`export const middleware = fromHono(...)`) contributes its own vars; a
 * plain `Middleware[]` (not a `stack(...)` tuple) contributes nothing - its element types are lost.
 */
export type InferStackVars<T> = T extends readonly [unknown, ...unknown[]]
    ? MergeStack<T>
    : T extends Middleware<Record<string, string>, ValidatedInput, any>
        ? VarsOf<T>
        : {};

/**
 * The vars injected by a module own `middleware` export (a `stack(...)`). Used by the
 * generated per-method handle so a verb file's own `export const middleware` types
 * `c.get`/`c.set`, on top of the folder's `+shared.ts` chain.
 */
export type MiddlewareVarsOf<M> = M extends { middleware: infer Stack }
    ? InferStackVars<Stack>
    : {};

/** A JSON Schema object (JSON Schema 2020-12 / OpenAPI 3.1 dialect). */
export type JsonSchema = Record<string, unknown>;

export const inputSchemaBrand: unique symbol = Symbol.for('giri.input-schema') as never;

export type InputValidationResult<Output = unknown> =
    | { ok: true; value: Output }
    | { ok: false; issues: unknown };

/**
 * A input schema every wrapper form (`body`/`query`) export takes. A vendor
 * adapter (`@boon4681/giri/validators/zod`, `@boon4681/giri/validators/valibot`, …) returns one; build a
 * custom one with `defineInputSchema`. giri core depends only on this interface, never
 * on a validator library. `validate` is the runtime check; `toJsonSchema` feeds OpenAPI.
 */
export interface GiriInputSchema<Output = unknown> {
    readonly [inputSchemaBrand]: true;
    validate(value: unknown): InputValidationResult<Output> | Promise<InputValidationResult<Output>>;
    toJsonSchema(): JsonSchema;
}

/** Extract the validated output type of a giri input schema: `Infer<typeof body>`. */
export type Infer<T> = T extends GiriInputSchema<infer Output> ? Output : never;

export type BodyContentType = 'json' | 'form' | 'urlencoded' | 'text';

export const bodySchemaBrand: unique symbol = Symbol.for('giri.body-schema') as never;

/**
 * A request body declared as a set of accepted content-types wrapped form `body`
 * takes (`zod.body({ json, form })`). One key means that encoding only; several mean the
 * endpoint accepts any of them, dispatched at runtime on the request `Content-Type`.
 * Each entry is a plain `GiriInputSchema`, so `validate`/`toJsonSchema` work per content-type.
 */
export interface GiriBodySchema<
    Outputs extends Partial<Record<BodyContentType, unknown>> = Partial<Record<BodyContentType, unknown>>,
> {
    readonly [bodySchemaBrand]: true;
    readonly contents: { [K in keyof Outputs & BodyContentType]: GiriInputSchema<Outputs[K]> };
}

/** True when `T` is a union of more than one member. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * The validated body a handler receives. A single declared content-type yields that
 * schema's output directly; several yield a discriminated union keyed by content-type.
 */
export type ValidBody<B> = B extends GiriBodySchema<infer Outputs>
    ? IsUnion<keyof Outputs> extends true
        ? { [K in keyof Outputs]: { type: K; data: Outputs[K] } }[keyof Outputs]
        : Outputs[keyof Outputs]
    : never;

/** The validated query a handler receives. */
export type ValidQuery<Q> = Q extends GiriInputSchema<infer Output> ? Output : never;

/** Drop keys whose value resolved to `never` (an input the route didn't declare). */
type PruneNever<T> = { [K in keyof T as [T[K]] extends [never] ? never : K]: T[K] };

/**
 * Derive a route's `ValidatedInput` from a module's `body`/`query` exports. The generated
 * per-method `$types` handle (`POST`, `GET`, …) uses this so handlers infer `c.req.valid`
 * with no manual generic.
 */
export type RouteInputOf<M> = PruneNever<{
    body: M extends { body: infer B } ? ValidBody<B> : never;
    query: M extends { query: infer Q } ? ValidQuery<Q> : never;
}>;

export interface RouteInput {
    body?: GiriBodySchema;
    query?: GiriInputSchema;
}

export interface RouteOpenApi {
    /** Omit this route from the generated `openapi.json` (it still serves normally). */
    hidden?: boolean;
    // Room to grow: summary, description, tags, deprecated, operationId, …
}

export type RouteOpenApiConfig = RouteOpenApi | boolean;

export interface GiriRouteRegistration {
    method: HttpMethod;
    path: string;
    handle: Handle;
    middleware: Middleware[];
    input?: RouteInput;
    /** App-wide services to seed onto `c.app` (same instance for every route). */
    services?: Services;
}

export type GiriFetchHandler = (req: Request) => Response | Promise<Response>;

export interface GiriServeOptions {
    port: number;
    hostname?: string;
}

export interface GiriServerInfo {
    address: string;
    port: number;
}

export interface GiriServer {
    close(): void | Promise<void>;
}

export interface GiriAdapter<App> {
    name?: string;
    createApp(): App;
    register(app: App, route: GiriRouteRegistration): void;
    fetch(app: App, req: Request): Promise<Response>;
    /**
     * Bind the configured backend's runtime to a port and start serving.
     * giri core stays runtime-agnostic: it hands the adapter a request handler
     * (so hot-reload keeps working) and the adapter owns the actual server.
     */
    serve(
        handler: GiriFetchHandler,
        options: GiriServeOptions,
        onListen?: (info: GiriServerInfo) => void,
    ): GiriServer;
}

export interface GiriConfig<App = unknown> {
    adapter: GiriAdapter<App>;
    alias?: Record<string, string | string[]>;
    outDir?: string;
    server?: {
        port?: number;
        hostname?: string;
    };
    errorSchema?: unknown;
}

export interface GiriPaths {
    cwd: string;
    routesDir: string;
    outDir: string;
}

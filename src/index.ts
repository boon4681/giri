import type { GiriConfig } from './types';

export {
    composeMiddleware,
    createContext,
    createTypedResponse,
    defineMiddleware,
    isTypedResponse,
    stack,
    toResponse,
    typedResponseToResponse,
} from './context';
export {
    defineBodySchema,
    defineInputSchema,
    isGiriBodySchema,
    isGiriInputSchema,
    prepareRequestInput,
} from './validation';
export { buildGiriApp, resolveGiriPaths } from './app';
export { scanRoutes } from './routes';
export { syncProject } from './generator';
export { loadLifecycle, runInit } from './lifecycle';
export type { GiriLifecycle } from './lifecycle';
export type {
    BodyContentType,
    Context,
    CookieJar,
    CookieJarFactory,
    CookieOptions,
    CookieSink,
    GiriAdapter,
    GiriBodySchema,
    GiriConfig,
    GiriFetchHandler,
    GiriInputSchema,
    GiriPaths,
    GiriRequest,
    GiriRouteRegistration,
    GiriServeOptions,
    GiriServer,
    GiriServerInfo,
    Handle,
    HandlerResponse,
    HttpMethod,
    Infer,
    InferStackVars,
    InputValidationResult,
    JsonSchema,
    MergeStack,
    Middleware,
    MiddlewareVarsOf,
    MiddlewareOpenApi,
    MiddlewareOptions,
    Next,
    RouteInput,
    RouteInputOf,
    RouteOpenApi,
    RouteOpenApiConfig,
    SecurityRequirement,
    Services,
    StatusCode,
    TypedResponse,
    ValidatedInput,
    ValidBody,
    ValidQuery,
    VarsOf,
} from './types';

export function defineConfig<App>(config: GiriConfig<App>): GiriConfig<App> {
    return config;
}

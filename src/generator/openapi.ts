import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenAPIV3_1 } from 'openapi-types';
import type { ScannedRoute } from '../routes';
import type { GiriPaths } from '../types';
import type { RouteInputSchemas } from './inputs';
import type { RouteSecurity } from './route-meta';
import type { JSONSchema, ResponseSchema, RouteResponses } from './schema';
import { writeJson } from './util';

export interface OpenApiData {
    responsesByFile?: Map<string, RouteResponses>;
    inputsByFile?: Map<string, RouteInputSchemas>;
    securityByFile?: Map<string, RouteSecurity>;
    hiddenFiles?: Set<string>;
}

type JsonObject = Record<string, unknown>;

const REASON: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    500: 'Internal Server Error',
};

function toOpenApiPath(path: string): string {
    return path.replace(/:([A-Za-z0-9_]+)(?:\{[^}]*\})?/g, '{$1}');
}

/** Rewrite walker-local `#/$defs/X` refs to the document-level `#/components/schemas/X`. */
function rewriteRefs(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(rewriteRefs);
    }
    if (value && typeof value === 'object') {
        const out: JsonObject = {};
        for (const [key, child] of Object.entries(value)) {
            if (key === '$ref' && typeof child === 'string' && child.startsWith('#/$defs/')) {
                out.$ref = child.replace('#/$defs/', '#/components/schemas/');
            } else {
                out[key] = rewriteRefs(child);
            }
        }
        return out;
    }
    return value;
}

function mediaTypeFor(format: 'json' | 'text'): string {
    return format === 'text' ? 'text/plain' : 'application/json';
}

const BODY_MEDIA_TYPE: Record<string, string> = {
    json: 'application/json',
    form: 'multipart/form-data',
    urlencoded: 'application/x-www-form-urlencoded',
    text: 'text/plain',
};

function buildResponses(responses: ResponseSchema[]): JsonObject {
    if (responses.length === 0) {
        return { default: { description: 'Response' } };
    }

    const out: JsonObject = {};
    for (const response of responses) {
        const key = response.status === 'default' ? 'default' : String(response.status);
        const description =
            (typeof response.status === 'number' && REASON[response.status]) || 'Response';
        out[key] = {
            description,
            content: { [mediaTypeFor(response.format)]: { schema: rewriteRefs(response.schema) } },
        };
    }
    return out;
}

function pathParameters(route: ScannedRoute): JsonObject[] {
    const seen = new Set<string>();
    const params: JsonObject[] = [];
    for (const param of route.params) {
        if (seen.has(param.name)) {
            continue;
        }
        seen.add(param.name);
        params.push({ name: param.name, in: 'path', required: true, schema: { type: 'string' } });
    }
    return params;
}

function queryParameters(query: JSONSchema | undefined): JsonObject[] {
    if (!query || query.type !== 'object' || typeof query.properties !== 'object') {
        return [];
    }
    const properties = query.properties as Record<string, JSONSchema>;
    const required = Array.isArray(query.required) ? (query.required as string[]) : [];
    return Object.entries(properties).map(([name, schema]) => ({
        name,
        in: 'query',
        required: required.includes(name),
        schema: rewriteRefs(schema),
    }));
}

function readProjectInfo(cwd: string): { title: string; version: string } {
    const file = join(cwd, 'package.json');
    if (existsSync(file)) {
        try {
            const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
            return { title: pkg.name ?? 'giri API', version: pkg.version ?? '0.0.0' };
        } catch {
            // fall through to defaults
        }
    }
    return { title: 'giri API', version: '0.0.0' };
}

/** Assemble an OpenAPI 3.1 document from the scanned routes + generated schemas. */
export function buildOpenApiDocument(
    paths: GiriPaths,
    routes: ScannedRoute[],
    data: OpenApiData = {},
): OpenAPIV3_1.Document {
    const documentPaths: JsonObject = {};
    const schemas: JsonObject = {};
    const securitySchemes: JsonObject = {};

    for (const route of routes) {
        if (data.hiddenFiles?.has(route.file)) {
            continue; // excluded from the doc via `openapi`/`+shared.ts`
        }
        const responses = data.responsesByFile?.get(route.file);
        const input = data.inputsByFile?.get(route.file);
        const security = data.securityByFile?.get(route.file);

        for (const [name, schema] of Object.entries(responses?.$defs ?? {})) {
            schemas[name] = rewriteRefs(schema);
        }

        const operation: JsonObject = { responses: buildResponses(responses?.responses ?? []) };

        const parameters = [...pathParameters(route), ...queryParameters(input?.query)];
        if (parameters.length > 0) {
            operation.parameters = parameters;
        }
        if (input?.body) {
            const content: JsonObject = {};
            for (const [contentType, schema] of Object.entries(input.body)) {
                content[BODY_MEDIA_TYPE[contentType] ?? contentType] = {
                    schema: rewriteRefs(schema),
                };
            }
            if (Object.keys(content).length > 0) {
                operation.requestBody = { required: true, content };
            }
        }
        if (security && security.security.length > 0) {
            operation.security = security.security;
        }
        if (security) {
            Object.assign(securitySchemes, security.securitySchemes);
        }

        const openApiPath = toOpenApiPath(route.path);
        const pathItem = (documentPaths[openApiPath] as JsonObject) ?? {};
        pathItem[route.method.toLowerCase()] = operation;
        documentPaths[openApiPath] = pathItem;
    }

    const document: JsonObject = {
        openapi: '3.1.0',
        info: readProjectInfo(paths.cwd),
        paths: documentPaths,
    };
    const components: JsonObject = {};
    if (Object.keys(schemas).length > 0) {
        components.schemas = schemas;
    }
    if (Object.keys(securitySchemes).length > 0) {
        components.securitySchemes = securitySchemes;
    }
    if (Object.keys(components).length > 0) {
        document.components = components;
    }
    return document as unknown as OpenAPIV3_1.Document;
}

/** Emit `.giri/openapi.json`. */
export async function writeOpenApi(
    paths: GiriPaths,
    routes: ScannedRoute[],
    data: OpenApiData = {},
): Promise<void> {
    await writeJson(join(paths.outDir, 'openapi.json'), buildOpenApiDocument(paths, routes, data));
}

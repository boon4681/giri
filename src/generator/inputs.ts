import { isGiriBodySchema, isGiriInputSchema } from '../validation';
import type { BodyContentType, GiriBodySchema, GiriInputSchema } from '../types';
import type { JSONSchema } from './schema';

export interface RouteInputSchemas {
    /** JSON Schema per declared body content-type (`json`, `form`, …). */
    body?: Partial<Record<BodyContentType, JSONSchema>>;
    query?: JSONSchema;
}

function sanitize(schema: JSONSchema): JSONSchema {
    // `$schema` is meaningful standalone but noise once embedded in OpenAPI.
    const { $schema, ...rest } = schema;
    void $schema;
    return rest;
}

/**
 * Convert a declared input to JSON Schema by asking the wrapper.
 */
export function inputToJsonSchema(schema: unknown): JSONSchema | undefined {
    if (!isGiriInputSchema(schema)) {
        return undefined;
    }
    try {
        return sanitize(schema.toJsonSchema());
    } catch (error) {
        // A schema that can't be rendered to JSON Schema only costs its own request
        // documentation - it must not discard the route's other metadata (tags/security).
        console.warn(`giri: skipped a request schema that can't be represented as JSON Schema (${(error as Error).message}).`);
        return undefined;
    }
}

/**
 * Convert a declared body (`zod.body({ json, form })`) to a JSON Schema per content-type.
 * Returns `undefined` when the value isn't a giri body schema or carries no schemas.
 */
export function bodyToJsonSchemas(
    value: unknown,
): Partial<Record<BodyContentType, JSONSchema>> | undefined {
    if (!isGiriBodySchema(value)) {
        return undefined;
    }
    const out: Partial<Record<BodyContentType, JSONSchema>> = {};
    for (const [contentType, schema] of Object.entries(value.contents)) {
        const json = inputToJsonSchema(schema);
        if (json) {
            out[contentType as BodyContentType] = json;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/** Combine object JSON Schemas into one (union of properties + required). Mirrors the runtime merge. */
function mergeObjectJsonSchemas(schemas: JSONSchema[]): JSONSchema {
    const properties: Record<string, JSONSchema> = {};
    const required = new Set<string>();
    let mergedAny = false;
    for (const schema of schemas) {
        if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
            mergedAny = true;
            Object.assign(properties, schema.properties as Record<string, JSONSchema>);
            if (Array.isArray(schema.required)) {
                for (const name of schema.required as string[]) {
                    required.add(name);
                }
            }
        }
    }
    // Nothing object-shaped to merge: keep the last owner's schema rather than invent one.
    if (!mergedAny) {
        return schemas[schemas.length - 1];
    }
    const merged: JSONSchema = { type: 'object', properties };
    if (required.size > 0) {
        merged.required = [...required];
    }
    return merged;
}

/** Merge every query owner's schema into the single JSON Schema OpenAPI documents. */
export function queryToJsonSchema(schemas: readonly GiriInputSchema[] | undefined): JSONSchema | undefined {
    if (!schemas || schemas.length === 0) {
        return undefined;
    }
    const jsons = schemas
        .map((schema) => inputToJsonSchema(schema))
        .filter((json): json is JSONSchema => json !== undefined);
    if (jsons.length === 0) {
        return undefined;
    }
    return jsons.length === 1 ? jsons[0] : mergeObjectJsonSchemas(jsons);
}

/** Merge every body owner's schemas into one JSON Schema per content-type. */
export function bodiesToJsonSchemas(
    schemas: readonly GiriBodySchema[] | undefined,
): Partial<Record<BodyContentType, JSONSchema>> | undefined {
    if (!schemas || schemas.length === 0) {
        return undefined;
    }
    const perType = new Map<BodyContentType, JSONSchema[]>();
    for (const schema of schemas) {
        const single = bodyToJsonSchemas(schema);
        if (!single) {
            continue;
        }
        for (const [contentType, json] of Object.entries(single)) {
            const key = contentType as BodyContentType;
            const list = perType.get(key) ?? [];
            list.push(json);
            perType.set(key, list);
        }
    }
    const out: Partial<Record<BodyContentType, JSONSchema>> = {};
    for (const [contentType, jsons] of perType) {
        out[contentType] = jsons.length === 1 ? jsons[0] : mergeObjectJsonSchemas(jsons);
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

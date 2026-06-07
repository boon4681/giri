import { isGiriBodySchema, isGiriInputSchema } from '../validation';
import type { BodyContentType } from '../types';
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
    return sanitize(schema.toJsonSchema());
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

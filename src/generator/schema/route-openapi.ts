import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const StringSchema = Type.String();
const BooleanSchema = Type.Boolean();
const StringArraySchema = Type.Array(StringSchema);

/** Runtime shape of a route/`+shared.ts` `openapi` object (booleans are handled by the caller). */
export const routeOpenApiSchema = Type.Object(
    {
        hidden: Type.Optional(BooleanSchema),
        tags: Type.Optional(StringArraySchema),
        summary: Type.Optional(StringSchema),
        description: Type.Optional(StringSchema),
        deprecated: Type.Optional(BooleanSchema),
        operationId: Type.Optional(StringSchema),
    },
    { additionalProperties: true },
);

export type RouteOpenApiInput = Static<typeof routeOpenApiSchema>;

function pick<T extends TSchema>(schema: T, value: unknown): Static<T> | undefined {
    return Value.Check(schema, value) ? (value as Static<T>) : undefined;
}

/**
 * Parse an arbitrary `openapi` value into its known fields, dropping anything mistyped
 * field-by-field rather than rejecting the whole object — a malformed `summary` must not
 * discard a valid `tags`.
 */
export function parseRouteOpenApi(value: unknown): RouteOpenApiInput | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const o = value as Record<string, unknown>;
    const parsed: RouteOpenApiInput = {};
    if ('hidden' in o) {
        parsed.hidden = Boolean(o.hidden);
    }
    const tags = pick(StringArraySchema, o.tags);
    if (tags) {
        parsed.tags = tags;
    }
    parsed.summary = pick(StringSchema, o.summary);
    parsed.description = pick(StringSchema, o.description);
    parsed.operationId = pick(StringSchema, o.operationId);
    parsed.deprecated = pick(BooleanSchema, o.deprecated);
    return parsed;
}

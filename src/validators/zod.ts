import { z } from 'zod';
import { defineBodySchema, defineInputSchema } from '../validation';
import type { BodyContentType, GiriBodySchema, GiriInputSchema } from '../types';

/** Wrap a single Zod schema as a giri input schema (validate via `safeParse`, JSON Schema via Zod 4). */
function wrap<Schema extends z.ZodType>(schema: Schema): GiriInputSchema<z.infer<Schema>> {
    return defineInputSchema<z.infer<Schema>>({
        validate(value) {
            const result = schema.safeParse(value);
            return result.success
                ? { ok: true, value: result.data }
                : { ok: false, issues: result.error };
        },
        toJsonSchema() {
            return z.toJSONSchema(schema) as Record<string, unknown>;
        },
    });
}

/**
 * Zod adapter. Peer-depends `zod`.
 *
 * ```ts
 * import { z } from 'zod';
 * import { zod } from 'giri/validators/zod';
 *
 * // JSON body
 * export const body = zod.body({ json: z.object({ name: z.string().min(1) }) });
 * // JSON *or* multipart dispatched on Content-Type at runtime
 * export const body = zod.body({
 *   json: z.object({ name: z.string() }),
 *   form: z.object({ name: z.string(), avatar: z.instanceof(File) }),
 * });
 * export const query = zod.query(z.object({ page: z.coerce.number() }));
 * ```
 */
export const zod = {
    body<Map extends Partial<Record<BodyContentType, z.ZodType>>>(
        map: Map,
    ): GiriBodySchema<{ [K in keyof Map]: Map[K] extends z.ZodType ? z.infer<Map[K]> : never }> {
        const contents = {} as Record<BodyContentType, GiriInputSchema>;
        for (const [contentType, schema] of Object.entries(map)) {
            if (schema) {
                contents[contentType as BodyContentType] = wrap(schema);
            }
        }
        return defineBodySchema(contents) as unknown as GiriBodySchema<{
            [K in keyof Map]: Map[K] extends z.ZodType ? z.infer<Map[K]> : never;
        }>;
    },
    query<Schema extends z.ZodType>(schema: Schema): GiriInputSchema<z.infer<Schema>> {
        return wrap(schema);
    },
};

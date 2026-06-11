import { inputToJsonSchema } from '../src/generator/inputs';
import { defineInputSchema } from '../src/validation';

describe('inputToJsonSchema', () => {
    it('reads toJsonSchema() from a wrapped input schema and strips $schema', () => {
        const body = defineInputSchema({
            validate: (value) => ({ ok: true, value }),
            toJsonSchema: () => ({
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
                properties: { a: { type: 'string' } },
            }),
        });
        expect(inputToJsonSchema(body)).toEqual({
            type: 'object',
            properties: { a: { type: 'string' } },
        });
    });

    it('returns undefined for anything not wrapped', () => {
        expect(inputToJsonSchema(undefined)).toBeUndefined();
        // A bare JSON-Schema object or a raw validator is no longer accepted.
        expect(inputToJsonSchema({ type: 'string' })).toBeUndefined();
        expect(inputToJsonSchema({ safeParse() {} })).toBeUndefined();
    });

    it('swallows a schema that cannot render to JSON Schema instead of throwing', () => {
        // e.g. `z.instanceof(File)` - the route keeps its tags/security; only the body doc is lost.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const body = defineInputSchema({
            validate: (value) => ({ ok: true, value }),
            toJsonSchema: () => {
                throw new Error('Custom types cannot be represented in JSON Schema');
            },
        });
        expect(() => inputToJsonSchema(body)).not.toThrow();
        expect(inputToJsonSchema(body)).toBeUndefined();
        warn.mockRestore();
    });
});

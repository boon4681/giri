import * as v from 'valibot';
import { z } from 'zod';
import { isGiriBodySchema, isGiriInputSchema } from '../src/validation';
import { valibot } from '../src/validators/valibot';
import { zod } from '../src/validators/zod';

describe('validator adapters', () => {
    it('zod.body() wraps each content-type and exposes JSON Schema', async () => {
        const body = zod.body({ json: z.object({ name: z.string().min(1) }) });

        expect(isGiriBodySchema(body)).toBe(true);
        const json = body.contents.json;
        expect(isGiriInputSchema(json)).toBe(true);
        expect(await json.validate({ name: 'Ada' })).toEqual({ ok: true, value: { name: 'Ada' } });
        expect((await json.validate({ name: '' })).ok).toBe(false);
        expect(json.toJsonSchema()).toMatchObject({
            type: 'object',
            properties: { name: { type: 'string', minLength: 1 } },
            required: ['name'],
        });
    });

    it('zod.query() wraps a single schema', async () => {
        const query = zod.query(z.object({ page: z.string() }));

        expect(isGiriInputSchema(query)).toBe(true);
        expect(await query.validate({ page: '2' })).toEqual({ ok: true, value: { page: '2' } });
    });

    it('valibot.body() wraps each content-type and exposes JSON Schema', async () => {
        const body = valibot.body({ json: v.object({ name: v.pipe(v.string(), v.minLength(1)) }) });

        expect(isGiriBodySchema(body)).toBe(true);
        const json = body.contents.json;
        expect(isGiriInputSchema(json)).toBe(true);
        expect(await json.validate({ name: 'Ada' })).toEqual({ ok: true, value: { name: 'Ada' } });
        expect((await json.validate({ name: '' })).ok).toBe(false);
        expect(json.toJsonSchema()).toMatchObject({
            type: 'object',
            properties: { name: { type: 'string', minLength: 1 } },
            required: ['name'],
        });
    });
});

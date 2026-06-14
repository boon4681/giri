import { z } from 'zod';
import { prepareRequestInput } from '../src/validation';
import { zod } from '../src/validators/zod';

const url = 'http://giri.test/users';

function jsonRequest(payload: unknown): Request {
    return new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

describe('prepareRequestInput', () => {
    it('single content-type body yields the validated value directly', async () => {
        const input = { body: [zod.body({ json: z.object({ name: z.string().min(1) }) })] };

        const ok = await prepareRequestInput(jsonRequest({ name: 'Ada' }), input);
        expect(ok).toEqual({ ok: true, validated: { body: { name: 'Ada' } } });

        const bad = await prepareRequestInput(jsonRequest({ name: '' }), input);
        expect(bad.ok).toBe(false);
        if (!bad.ok) {
            expect(bad.response.status).toBe(400);
        }
    });

    it('multi content-type body dispatches on Content-Type into a discriminated result', async () => {
        const input = {
            body: [zod.body({
                json: z.object({ name: z.string() }),
                form: z.object({ name: z.string(), avatar: z.string() }),
            })],
        };

        const fromJson = await prepareRequestInput(jsonRequest({ name: 'Ada' }), input);
        expect(fromJson).toEqual({ ok: true, validated: { body: { type: 'json', data: { name: 'Ada' } } } });

        const form = new FormData();
        form.set('name', 'Ada');
        form.set('avatar', 'pic.png');
        const fromForm = await prepareRequestInput(
            new Request(url, { method: 'POST', body: form }),
            input,
        );
        expect(fromForm).toEqual({
            ok: true,
            validated: { body: { type: 'form', data: { name: 'Ada', avatar: 'pic.png' } } },
        });
    });

    it('rejects an undeclared content-type with 415', async () => {
        const input = { body: [zod.body({ form: z.object({ name: z.string() }) })] };

        const result = await prepareRequestInput(jsonRequest({ name: 'Ada' }), input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.response.status).toBe(415);
        }
    });

    it('validates query parameters', async () => {
        const input = { query: [zod.query(z.object({ page: z.string() }))] };

        const result = await prepareRequestInput(
            new Request(`${url}?page=2`, { method: 'GET' }),
            input,
        );
        expect(result).toEqual({ ok: true, validated: { query: { page: '2' } } });
    });

    it('merges the validated output of several query owners', async () => {
        const input = {
            query: [
                zod.query(z.object({ size: z.string().optional(), page: z.string().optional() })),
                zod.query(z.object({ filter: z.string().optional() })),
            ],
        };

        const result = await prepareRequestInput(
            new Request(`${url}?size=10&page=2&filter=active`, { method: 'GET' }),
            input,
        );
        expect(result).toEqual({
            ok: true,
            validated: { query: { size: '10', page: '2', filter: 'active' } },
        });
    });

    it('a failing query owner rejects with 400', async () => {
        const input = {
            query: [
                zod.query(z.object({ page: z.string().optional() })),
                zod.query(z.object({ size: z.string() })), // required, missing
            ],
        };

        const result = await prepareRequestInput(new Request(`${url}?page=2`, { method: 'GET' }), input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.response.status).toBe(400);
        }
    });

    it('merges the validated output of several json body owners', async () => {
        const input = {
            body: [
                zod.body({ json: z.object({ a: z.string() }) }),
                zod.body({ json: z.object({ b: z.string() }) }),
            ],
        };

        const result = await prepareRequestInput(jsonRequest({ a: 'x', b: 'y' }), input);
        expect(result).toEqual({ ok: true, validated: { body: { a: 'x', b: 'y' } } });
    });
});

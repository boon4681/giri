import { composeMiddleware, createContext, defineMiddleware, isTypedResponse, toResponse } from '../src';

describe('context', () => {
    it('creates typed JSON responses and converts them to real responses', async () => {
        const context = createContext({
            request: new Request('http://giri.test/hello'),
            params: { id: '123' },
        });

        const typed = context.json({ ok: true, id: context.params.id }, 201);

        expect(isTypedResponse(typed)).toBe(true);
        expect(typed.status).toBe(201);

        const response = toResponse(typed);
        expect(response.status).toBe(201);
        expect(response.headers.get('content-type')).toContain('application/json');
        await expect(response.json()).resolves.toEqual({ ok: true, id: '123' });
    });

    it('runs middleware before the handler and preserves context values', async () => {
        const context = createContext({
            request: new Request('http://giri.test/hello'),
        });
        const middleware = defineMiddleware(async (c, next) => {
            c.set('user', { id: 'u1' });
            await next();
        });

        const result = await composeMiddleware([middleware], (c) => {
            return c.json({ user: c.get<{ id: string }>('user').id });
        }, context);

        const response = toResponse(result);
        await expect(response.json()).resolves.toEqual({ user: 'u1' });
    });
});

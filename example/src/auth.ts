import { defineMiddleware } from "giri";

// Tag the middleware once with its OpenAPI security. Any route that uses `auth`
// shows `bearerAuth` in the generated doc; routes that don't stay public.
export const auth = defineMiddleware<{ userId: string }>(
    {
        openapi: {
            security: [{ bearerAuth: [] }],
            securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
        },
    },
    async (c, next) => {
        // verify a token here…
        await next();
    },
);

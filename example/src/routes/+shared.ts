import { defineMiddleware, stack } from "@boon4681/giri";
import { zod } from "@boon4681/giri/validators/zod";
import type { Middleware } from "./$types";
import z from "zod";

// Declares the var it injects. Every handler below sees `c.get("requestId"): string`.
const requestId: Middleware<{ requestId: string }> = async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? "example-request");
    await next();
};

const q = defineMiddleware({ query: zod.query(z.object({ p: z.string().optional() })) }, async (c, next) => {
    await next()
})

export const middleware = stack(q, requestId);


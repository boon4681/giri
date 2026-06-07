import { stack } from "giri";
import type { Middleware } from "./$types";

// Declares the var it injects. Every handler below sees `c.get("requestId"): string`.
const requestId: Middleware<{ requestId: string }> = async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? "example-request");
    await next();
};

export const middleware = stack(requestId);


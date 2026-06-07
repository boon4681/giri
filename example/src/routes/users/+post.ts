import { z } from "zod";
import { zod } from "giri/validators/zod";
import { stack } from "giri";
import type { POST } from "./$types";
import { createUser } from "../../db";
import { auth } from "../../auth";

export const middleware = stack(auth);

export const body = zod.body({
    json: z.object({
        name: z.string().min(1),
    }),
});

export const handle: POST = (c) => {
    const userId: string = c.get("userId"); // injected by `middleware = stack(auth)`
    console.log(userId)
    const user = createUser(c.req.valid("body").name);
    return c.json({ ...user, createdBy: userId }, 201);
};

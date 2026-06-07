import type { Handle } from "giri";
import { listUsers } from "../../db";

export const handle: Handle = (c) => {
    return c.json({
        requestId: c.get("requestId"),
        users: listUsers(),
    });
}

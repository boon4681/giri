import type { Handle } from "./$types";

export const openapi = false;

export const handle: Handle = (c) => {
    const doc = require("$giri/openapi.json");
    return c.json(doc);
};

import { defineConfig } from "giri";
import { hono } from "giri/adapters/hono";

export default defineConfig({
    adapter: hono(),
    server: {
        port: 3000,
    },
    alias:{
        "$db":"./src/db.ts"
    }
});

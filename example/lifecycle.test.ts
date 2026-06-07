import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGiriApp, loadLifecycle, runInit } from "giri";
import config from "./giri.config";

const cwd = fileURLToPath(new URL(".", import.meta.url));

describe("example lifecycle", () => {
    it("loads init and teardown from src/main.ts", async () => {
        const lifecycle = await loadLifecycle(cwd);
        expect(typeof lifecycle.init).toBe("function");
        expect(typeof lifecycle.teardown).toBe("function");
    });

    it("seeds init() services onto c.app in every handler", async () => {
        const lifecycle = await loadLifecycle(cwd);
        const services = await runInit(lifecycle);
        expect(services).toEqual({ a: 5 });

        const built = await buildGiriApp(config, { cwd, services });
        const response = await config.adapter.fetch(
            built.app,
            new Request("http://giri.test/"),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ appA: 5 });
    });

    it("runs teardown with the init() services without throwing", async () => {
        const lifecycle = await loadLifecycle(cwd);
        const services = await runInit(lifecycle);
        await expect(
            Promise.resolve(lifecycle.teardown?.(services)),
        ).resolves.toBeUndefined();
    });
});

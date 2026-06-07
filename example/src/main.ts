import type { Services } from "giri";

export const init = () => {
    return { a: 5 }
}

export const teardown = (services: Services) => {
    void services.a // close DB pools, flush telemetry, etc.
}
import { Static, Type } from "@sinclair/typebox";

export const configSchema = Type.Object({
    adapter: Type.Any(),
    alias: Type.Optional(Type.Record(
        Type.String(),
        Type.Union([Type.String(), Type.Array(Type.String())]),
    )),
    outDir: Type.Optional(Type.String()),
    server: Type.Optional(Type.Object({
        port: Type.Optional(Type.Number()),
        hostname: Type.Optional(Type.String()),
    }, { additionalProperties: false })),
    errorSchema: Type.Optional(Type.Any()),
    cookieSecret: Type.Optional(Type.String()),
}, { additionalProperties: false })
import process from 'node:process';
import { build } from 'tsup';

async function main(): Promise<void> {
    await build({
        entry: [
            'src/index.ts',
            'src/config.ts',
            'src/runtime.ts',
            'src/cli.ts',
            'src/adapters/hono.ts',
            'src/validators/zod.ts',
            'src/validators/valibot.ts',
            'src/typescript-plugin.ts',
        ],
        format: ['cjs'],
        // @clack/prompts is ESM-only; inline it so the CJS CLI doesn't require() an ES module (fails on Node < 22.12)
        noExternal: ['@clack/prompts'],
        dts: true,
        sourcemap: true,
        clean: true,
        tsconfig: 'tsconfig.json',
    });

    await build({
        entry: ['src/runtime.ts'],
        format: ['esm'],
        dts: false,
        sourcemap: true,
        clean: false,
        outExtension: () => ({ js: '.mjs' }),
        tsconfig: 'tsconfig.json',
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

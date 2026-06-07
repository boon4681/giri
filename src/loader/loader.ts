import { cancel, log, spinner } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { exit } from 'node:process';
import { configSchema } from '../config/schema';
import { Value } from "@sinclair/typebox/value"
import { Static } from '@sinclair/typebox';

const assertES5 = async (unregister: () => void) => {
    try {
        require('./_es5.ts');
    } catch (e: any) {
        if ('errors' in e && Array.isArray(e.errors) && e.errors.length > 0) {
            const es5Error = (e.errors as any[]).filter((it) => it.text?.includes(`("es5") is not supported yet`)).length > 0;
            if (es5Error) {
                log.error(
                    `Please change compilerOptions.target from 'es5' to 'es6' or above in your tsconfig.json`
                );
                exit(1);
            }
        }
        log.error(e);
        exit(1);
    }
};

export const safeRegister = async () => {
    const { register } = await import('esbuild-register/dist/node');
    let res: { unregister: () => void };
    try {
        res = register({
            format: 'cjs',
            loader: 'ts',
        });
    } catch {
        // tsx fallback
        res = {
            unregister: () => { },
        };
    }

    // has to be outside try catch to be able to run with tsx
    await assertES5(res.unregister);
    return res;
}

export const load = async () => {
    const defaultTsConfigExists = existsSync(resolve('giri.config.ts'));
    const defaultJsConfigExists = existsSync(resolve('giri.config.js'));
    const defaultConfigPath = defaultTsConfigExists ? 'giri.config.ts' : defaultJsConfigExists ? 'giri.config.js' : undefined
    if (!defaultConfigPath) {
        log.error("Config file not found.")
        exit(1)
    }

    const path: string = resolve(defaultConfigPath);
    if (!existsSync(path)) {
        log.error(`${path} file does not exist`);
        exit(1)
    }

    const { unregister } = await safeRegister();
    const required = require(`${path}`);
    const content = required.default ?? required;
    unregister();

    // get response and then check by each dialect independently
    const res = Value.Check(configSchema, content);
    if (!res) {
        for (const error of [...Value.Errors(configSchema, content)]) {
            log.error(error.message)
        }
        exit(1)
    }
    return content as Static<typeof configSchema>
}

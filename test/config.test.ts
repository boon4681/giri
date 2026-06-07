import { Value } from '@sinclair/typebox/value';
import { configSchema } from '../src/config/schema';

describe('config schema', () => {
    it('does not expose routesDir as a user config option', () => {
        expect(Value.Check(configSchema, {
            adapter: {},
            routesDir: 'custom/routes',
        })).toBe(false);
    });

    it('accepts the fixed-route-directory config shape', () => {
        expect(Value.Check(configSchema, {
            adapter: {},
            alias: {
                '@/*': ['src/*'],
                '@db': 'src/db.ts',
            },
            outDir: '.giri',
            server: {
                port: 3000,
            },
        })).toBe(true);
    });
});

import type { GiriConfig } from './types';

/** Lightweight config helper that does not load the generator or TypeScript compiler. */
export function defineConfig<App>(config: GiriConfig<App>): GiriConfig<App> {
    return config;
}

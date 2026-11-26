import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GiriPaths } from '../types';
import { GENERATED_HEADER, typeImport, writeGenerated } from './util';

const MAIN_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];

function findMainFile(cwd: string): string | undefined {
    for (const ext of MAIN_EXTENSIONS) {
        const file = join(cwd, 'src', `main.${ext}`);
        if (existsSync(file)) {
            return file;
        }
    }
    return undefined;
}

export async function writeAppTypes(paths: GiriPaths): Promise<void> {
    const file = join(paths.outDir, 'types', 'app.d.ts');
    const mainFile = findMainFile(paths.cwd);

    if (!mainFile) {
        await writeGenerated(file, [GENERATED_HEADER, 'export {};', ''].join('\n'));
        return;
    }

    const main = typeImport(join(paths.outDir, 'types'), mainFile);
    await writeGenerated(
        file,
        [
            GENERATED_HEADER,
            'declare global {',
            '  namespace Giri {',
            '    interface Register {',
            `      app: typeof ${main} extends {`,
            '        init: (...args: any[]) => infer R;',
            '      }',
            '        ? Awaited<R>',
            '        : Record<string, unknown>;',
            '    }',
            '  }',
            '}',
            'export {};',
            '',
        ].join('\n'),
    );
}

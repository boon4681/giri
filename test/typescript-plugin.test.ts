import { join } from 'node:path';
import { resolveGiriTypesImport } from '../src/typescript-plugin-core';

describe('typescript plugin resolution', () => {
    it('maps route-local ./$types imports to generated .giri types', () => {
        const projectDir = join(process.cwd(), 'test', '.tmp', 'plugin');
        const generated = join(
            projectDir,
            '.giri',
            'types',
            'routes',
            'users',
            '[id]',
            'posts',
            '[postId]',
            '$types.d.ts',
        );

        const resolved = resolveGiriTypesImport({
            moduleName: './$types',
            projectDir,
            containingFile: join(
                projectDir,
                'src',
                'routes',
                'users',
                '[id]',
                'posts',
                '[postId]',
                '+get.ts',
            ),
            fileExists: (path) => path === generated,
        });

        expect(resolved).toBe(generated);
    });

    it('ignores non-$types imports', () => {
        const resolved = resolveGiriTypesImport({
            moduleName: './db',
            projectDir: process.cwd(),
            containingFile: join(process.cwd(), 'src', 'routes', '+get.ts'),
            fileExists: () => true,
        });

        expect(resolved).toBeUndefined();
    });
});

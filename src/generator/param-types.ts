import { dirname } from 'node:path';
import type { RouteParam } from '../routes';
import type { GiriPaths, HttpMethod } from '../types';
import { GENERATED_HEADER, moduleSpecifier, typeFilePath, writeGenerated } from './util';

export interface TypeFolder {
    dir: string;
    params: RouteParam[];
    /** The `+shared.ts` chain whose injected vars apply here. */
    sharedFiles: string[];
    /** The verb files (`+get.ts`, `+post.ts`, …) in this folder, one method-named handle each. */
    verbs: { method: HttpMethod; file: string }[];
}

function paramsType(params: RouteParam[]): string {
    if (params.length === 0) {
        return '{}';
    }

    const unique = new Map<string, RouteParam>();
    for (const param of params) {
        unique.set(param.name, param);
    }

    const fields = [...unique.values()]
        .map((param) => `  ${JSON.stringify(param.name)}: string;`)
        .join('\n');
    return `{\n${fields}\n}`;
}

/** Merge the injected vars of the folder's `+shared.ts` middleware chain */
function varsType(typesDir: string, sharedFiles: string[]): string {
    if (sharedFiles.length === 0) {
        return '{}';
    }
    return sharedFiles
        .map((file) => {
            const spec = JSON.stringify(moduleSpecifier(typesDir, file));
            return `(typeof import(${spec}) extends { middleware: infer M } ? import("giri").InferStackVars<M> : {})`;
        })
        .join('\n    & ');
}

function methodExports(typesDir: string, verbs: TypeFolder['verbs']): string[] {
    return verbs.map(({ method, file }) => {
        const spec = JSON.stringify(moduleSpecifier(typesDir, file));
        const input = `import("giri").RouteInputOf<typeof import(${spec})>`;
        const vars = `Vars & import("giri").MiddlewareVarsOf<typeof import(${spec})>`;
        return `export type ${method} = import("giri").Handle<Params, ${input}, ${vars}>;`;
    });
}

export async function writeParamTypes(paths: GiriPaths, folders: TypeFolder[]): Promise<void> {
    for (const { dir, params, sharedFiles, verbs } of folders) {
        const file = typeFilePath(paths, dir);
        const typesDir = dirname(file);
        const lines = [
            GENERATED_HEADER,
            `export type Params = ${paramsType(params)};`,
            'export type RouteParams = Params;',
            `type Vars = ${varsType(typesDir, sharedFiles)};`,
            'export type Middleware<Injects extends Record<string, unknown> = {}> =',
            '  import("giri").Middleware<Params, import("giri").ValidatedInput, Injects>;',
            'export type Handle<Input extends import("giri").ValidatedInput = import("giri").ValidatedInput> =',
            '  import("giri").Handle<Params, Input, Vars>;',
        ];
        if (verbs.length > 0) {
            lines.push(...methodExports(typesDir, verbs));
        }
        lines.push('');
        await writeGenerated(file, lines.join('\n'));
    }
}

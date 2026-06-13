import { dirname } from 'node:path';
import type { RouteParam } from '../routes';
import type { GiriPaths, HttpMethod } from '../types';
import { GENERATED_HEADER, importPath, moduleSpecifier, typeFilePath, writeGenerated } from './util';

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
function middlewareVarsType(typesDir: string, sharedFile: string): string {
    const spec = JSON.stringify(moduleSpecifier(typesDir, sharedFile));
    return `(typeof import(${spec}) extends { middleware: infer M } ? import("@boon4681/giri").InferStackVars<M> : {})`;
}

function middlewareInputType(typesDir: string, sharedFile: string): string {
    const spec = JSON.stringify(moduleSpecifier(typesDir, sharedFile));
    return `(typeof import(${spec}) extends { middleware: infer M } ? import("@boon4681/giri").InferStackInput<M> : {})`;
}

function ownSharedFile(dir: string, sharedFiles: string[]): string | undefined {
    for (let index = sharedFiles.length - 1; index >= 0; index -= 1) {
        if (dirname(sharedFiles[index]) === dir) {
            return sharedFiles[index];
        }
    }
    return undefined;
}

function varsType(paths: GiriPaths, file: string, dir: string, sharedFiles: string[]): string {
    const typesDir = dirname(file);
    const parts: string[] = [];
    if (dir !== paths.routesDir) {
        parts.push(`import(${JSON.stringify(importPath(file, typeFilePath(paths, dirname(dir))))}).Vars`);
    }

    const ownShared = ownSharedFile(dir, sharedFiles);
    if (ownShared) {
        parts.push(middlewareVarsType(typesDir, ownShared));
    }

    return parts.length > 0 ? parts.join('\n    & ') : '{}';
}

function inputType(paths: GiriPaths, file: string, dir: string, sharedFiles: string[]): string {
    const typesDir = dirname(file);
    const parts: string[] = [];
    if (dir !== paths.routesDir) {
        parts.push(`import(${JSON.stringify(importPath(file, typeFilePath(paths, dirname(dir))))}).Input`);
    }

    const ownShared = ownSharedFile(dir, sharedFiles);
    if (ownShared) {
        parts.push(middlewareInputType(typesDir, ownShared));
    }

    return parts.length > 0 ? parts.join('\n    & ') : '{}';
}

function methodExports(typesDir: string, verbs: TypeFolder['verbs']): string[] {
    return verbs.map(({ method, file }) => {
        const spec = JSON.stringify(moduleSpecifier(typesDir, file));
        const input = [
            'Input',
            `import("@boon4681/giri").RouteInputOf<typeof import(${spec})>`,
            `import("@boon4681/giri").MiddlewareInputOf<typeof import(${spec})>`,
        ].join(' & ');
        const vars = `Vars & import("@boon4681/giri").MiddlewareVarsOf<typeof import(${spec})>`;
        return `export type ${method} = import("@boon4681/giri").Handle<Params, ${input}, ${vars}>;`;
    });
}

export async function writeParamTypes(paths: GiriPaths, folders: TypeFolder[]): Promise<void> {
    await Promise.all(folders.map(({ dir, params, sharedFiles, verbs }) => {
        const file = typeFilePath(paths, dir);
        const typesDir = dirname(file);
        const lines = [
            GENERATED_HEADER,
            `export type Params = ${paramsType(params)};`,
            'export type RouteParams = Params;',
            `export type Vars = ${varsType(paths, file, dir, sharedFiles)};`,
            `export type Input = ${inputType(paths, file, dir, sharedFiles)};`,
            'export type Middleware<Injects extends Record<string, unknown> = {}> =',
            '  import("@boon4681/giri").Middleware<Params, import("@boon4681/giri").ValidatedInput, Injects>;',
            'export type Handle<OwnInput extends import("@boon4681/giri").ValidatedInput = Input> =',
            '  import("@boon4681/giri").Handle<Params, Input & OwnInput, Vars>;',
        ];
        if (verbs.length > 0) {
            lines.push(...methodExports(typesDir, verbs));
        }
        lines.push('');
        return writeGenerated(file, lines.join('\n'));
    }));
}

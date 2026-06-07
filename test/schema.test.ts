import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { extractRouteResponses } from '../src/generator/schema';

const tmp = join(process.cwd(), 'test', '.tmp', 'schema');

function buildProgram(files: string[]): ts.Program {
    return ts.createProgram(files, {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        baseUrl: process.cwd(),
        paths: { giri: ['src/index.ts'] },
    });
}

async function writeRoute(name: string, lines: string[]): Promise<string> {
    const file = join(tmp, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, lines.join('\n'));
    return file;
}

describe('schema walker', () => {
    beforeEach(async () => {
        await rm(tmp, { recursive: true, force: true });
        await mkdir(tmp, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    it('extracts a 200 object schema through an annotated handle', async () => {
        const file = await writeRoute('object.ts', [
            'import type { Handle } from "giri";',
            'export const handle: Handle = (c) => c.json({ id: "x", count: 1 });',
        ]);

        const { responses } = extractRouteResponses(buildProgram([file]), file);
        expect(responses).toHaveLength(1);
        expect(responses[0]).toEqual({
            status: 200,
            format: 'json',
            schema: {
                type: 'object',
                properties: { id: { type: 'string' }, count: { type: 'number' } },
                required: ['id', 'count'],
                additionalProperties: false,
            },
        });
    });

    it('unwraps a multi-status union into per-status schemas', async () => {
        const file = await writeRoute('multi.ts', [
            'import type { Handle } from "giri";',
            'export const handle: Handle = (c) => {',
            '  if (Date.now() > 0) return c.json({ message: "missing" }, 404);',
            '  return c.json({ id: "x" });',
            '};',
        ]);

        const { responses } = extractRouteResponses(buildProgram([file]), file);
        expect(responses.map((r) => r.status)).toEqual([200, 404]);
        const notFound = responses.find((r) => r.status === 404);
        expect(notFound?.schema).toMatchObject({
            type: 'object',
            properties: { message: { type: 'string' } },
        });
    });

    it('translates optional fields, Date, and arrays via the serialization layer', async () => {
        const file = await writeRoute('user.ts', [
            'import type { Handle } from "giri";',
            'interface User { id: string; nick?: string; createdAt: Date; tags: string[] }',
            'declare const user: User;',
            'export const handle: Handle = (c) => c.json(user);',
        ]);

        const { responses } = extractRouteResponses(buildProgram([file]), file);
        expect(responses[0].schema).toEqual({
            type: 'object',
            properties: {
                id: { type: 'string' },
                nick: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' },
                tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'createdAt', 'tags'],
            additionalProperties: false,
        });
    });

    it('merges two same-status returns of different shapes into anyOf', async () => {
        const file = await writeRoute('two200.ts', [
            'import type { Handle } from "giri";',
            'export const handle: Handle = (c) => {',
            '  if (Date.now() > 0) return c.json({ a: 1 });',
            '  return c.json({ b: "x" });',
            '};',
        ]);

        const { responses } = extractRouteResponses(buildProgram([file]), file);
        expect(responses).toHaveLength(1);
        expect(responses[0].status).toBe(200);
        expect(responses[0].schema).toEqual({
            anyOf: [
                { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false },
                { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false },
            ],
        });
    });

    it('emits $ref/$defs for recursive types', async () => {
        const file = await writeRoute('tree.ts', [
            'import type { Handle } from "giri";',
            'interface Node { value: number; next?: Node }',
            'declare const node: Node;',
            'export const handle: Handle = (c) => c.json(node);',
        ]);

        const { responses, $defs } = extractRouteResponses(buildProgram([file]), file);
        expect(responses[0].schema).toEqual({ $ref: '#/$defs/Node' });
        expect($defs.Node).toEqual({
            type: 'object',
            properties: { value: { type: 'number' }, next: { $ref: '#/$defs/Node' } },
            required: ['value'],
            additionalProperties: false,
        });
    });
});

import { join } from 'node:path';
import type { ScannedRoute } from '../src/routes';
import type { GiriPaths } from '../src/types';
import { buildOpenApiDocument } from '../src/generator/openapi';
import type { RouteResponses } from '../src/generator/schema';
import type { RouteInputSchemas } from '../src/generator/inputs';

const paths: GiriPaths = {
    cwd: join(process.cwd(), 'test', '.tmp', 'no-package-here'),
    routesDir: '',
    outDir: '',
};

function route(partial: Partial<ScannedRoute> & Pick<ScannedRoute, 'method' | 'path' | 'file'>): ScannedRoute {
    return {
        routeDir: '',
        routeSegments: [],
        params: [],
        sharedFiles: [],
        ...partial,
    };
}

describe('buildOpenApiDocument', () => {
    it('converts paths, path params, body and responses', () => {
        const file = '/routes/users/[id]/+patch.ts';
        const routes = [
            route({
                method: 'PATCH',
                path: '/users/:id',
                file,
                params: [{ name: 'id', catchAll: false }],
            }),
        ];
        const inputs = new Map<string, RouteInputSchemas>([
            [
                file,
                { body: { json: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
            ],
        ]);
        const responses = new Map<string, RouteResponses>([
            [
                file,
                {
                    responses: [
                        { status: 200, format: 'json', schema: { type: 'object', properties: { id: { type: 'string' } } } },
                    ],
                    opaque: false,
                    warnings: [],
                    $defs: {},
                },
            ],
        ]);

        const doc = buildOpenApiDocument(paths, routes, { responsesByFile: responses, inputsByFile: inputs }) as any;

        expect(doc.openapi).toBe('3.1.0');
        expect(doc.info).toEqual({ title: 'giri API', version: '0.0.0' });
        const op = doc.paths['/users/{id}'].patch;
        expect(op.parameters).toEqual([
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ]);
        expect(op.requestBody.content['application/json'].schema).toEqual({
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
        });
        expect(op.responses['200'].description).toBe('OK');
        expect(op.responses['200'].content['application/json'].schema).toEqual({
            type: 'object',
            properties: { id: { type: 'string' } },
        });
    });

    it('hoists $defs into components.schemas and rewrites $ref', () => {
        const file = '/routes/tree/+get.ts';
        const responses = new Map<string, RouteResponses>([
            [
                file,
                {
                    responses: [{ status: 200, format: 'json', schema: { $ref: '#/$defs/Node' } }],
                    opaque: false,
                    warnings: [],
                    $defs: {
                        Node: {
                            type: 'object',
                            properties: { value: { type: 'number' }, next: { $ref: '#/$defs/Node' } },
                            required: ['value'],
                        },
                    },
                },
            ],
        ]);

        const doc = buildOpenApiDocument(
            paths,
            [route({ method: 'GET', path: '/tree', file })],
            { responsesByFile: responses },
        ) as any;

        expect(doc.paths['/tree'].get.responses['200'].content['application/json'].schema).toEqual({
            $ref: '#/components/schemas/Node',
        });
        expect(doc.components.schemas.Node.properties.next).toEqual({
            $ref: '#/components/schemas/Node',
        });
    });

    it('attaches middleware-derived security and merges securitySchemes', () => {
        const authed = '/routes/users/+post.ts';
        const publicGet = '/routes/users/+get.ts';
        const security = new Map([
            [
                authed,
                {
                    security: [{ bearerAuth: [] as string[] }],
                    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
                },
            ],
        ]);

        const doc = buildOpenApiDocument(
            paths,
            [
                route({ method: 'POST', path: '/users', file: authed }),
                route({ method: 'GET', path: '/users', file: publicGet }),
            ],
            { securityByFile: security },
        ) as any;

        expect(doc.paths['/users'].post.security).toEqual([{ bearerAuth: [] }]);
        expect(doc.paths['/users'].get.security).toBeUndefined();
        expect(doc.components.securitySchemes).toEqual({
            bearerAuth: { type: 'http', scheme: 'bearer' },
        });
    });

    it('omits routes listed in hiddenFiles', () => {
        const shown = '/routes/users/+get.ts';
        const hidden = '/routes/internal/+get.ts';

        const doc = buildOpenApiDocument(
            paths,
            [
                route({ method: 'GET', path: '/users', file: shown }),
                route({ method: 'GET', path: '/internal', file: hidden }),
            ],
            { hiddenFiles: new Set([hidden]) },
        ) as any;

        expect(Object.keys(doc.paths)).toEqual(['/users']);
    });

    it('expands query schema into query parameters', () => {
        const file = '/routes/search/+get.ts';
        const inputs = new Map<string, RouteInputSchemas>([
            [
                file,
                {
                    query: {
                        type: 'object',
                        properties: { q: { type: 'string' }, limit: { type: 'number' } },
                        required: ['q'],
                    },
                },
            ],
        ]);

        const doc = buildOpenApiDocument(paths, [route({ method: 'GET', path: '/search', file })], {
            inputsByFile: inputs,
        }) as any;

        expect(doc.paths['/search'].get.parameters).toEqual([
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'number' } },
        ]);
    });
});

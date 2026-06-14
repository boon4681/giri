import {
    type BodyContentType,
    type GiriBodySchema,
    type GiriInputSchema,
    type RouteInput,
    type TypedResponse,
    type ValidatedInput,
    bodySchemaBrand,
    inputSchemaBrand,
} from './types';
import { createTypedResponse } from './context';

interface PreparedInput {
    ok: true;
    validated: ValidatedInput;
}

interface FailedInput {
    ok: false;
    response: TypedResponse<{ message: string; issues: unknown }, 400 | 415, 'json'>;
}

export type PreparedRequestInput = PreparedInput | FailedInput;

export interface RouteInputSource {
    label: string;
    body?: unknown;
    query?: unknown;
}

/**
 * Build a giri input schema from a `validate` + `toJsonSchema` pair. Vendor adapters use
 * this; you can call it directly to make a custom validator. The brand is a global symbol,
 * so a hand-rolled `{ [Symbol.for("giri.input-schema")]: true, validate, toJsonSchema }` works too.
 */
export function defineInputSchema<Output>(
    schema: Omit<GiriInputSchema<Output>, typeof inputSchemaBrand>,
): GiriInputSchema<Output> {
    return { [inputSchemaBrand]: true, ...schema };
}

export function isGiriInputSchema(value: unknown): value is GiriInputSchema {
    return Boolean(
        value &&
            typeof value === 'object' &&
            (value as Record<symbol, unknown>)[inputSchemaBrand] === true,
    );
}

/**
 * Build a giri body schema from per-content-type input schemas. Validator adapters use this `zod.body({ json, form })`
 */
export function defineBodySchema<Outputs extends Partial<Record<BodyContentType, unknown>>>(
    contents: GiriBodySchema<Outputs>['contents'],
): GiriBodySchema<Outputs> {
    return { [bodySchemaBrand]: true, contents };
}

export function isGiriBodySchema(value: unknown): value is GiriBodySchema {
    return Boolean(
        value &&
            typeof value === 'object' &&
            (value as Record<symbol, unknown>)[bodySchemaBrand] === true,
    );
}

/**
 * A route/middleware declared a target (`body`/`query`) without wrapping it in a validator.
 * Branded so callers (e.g. the generator) can tell an actionable config error apart from a
 * route that merely failed to load.
 */
export class RouteInputError extends Error {
    override readonly name = 'RouteInputError';
}

/**
 * Collect every owner's validator for each target (`body`/`query`). A route export and any
 * applied middleware can each contribute one; their validated outputs are merged at request time
 * (see {@link prepareRequestInput}), matching the type layer which intersects them. Owners are
 * kept in source order (middleware first, then the route) so a route's fields win on collision.
 */
export function resolveRouteInput(sources: readonly RouteInputSource[]): RouteInput | undefined {
    const body: GiriBodySchema[] = [];
    const query: GiriInputSchema[] = [];

    for (const source of sources) {
        if (source.body !== undefined) {
            if (!isGiriBodySchema(source.body)) {
                throw new RouteInputError(
                    `${source.label}: "body" must be wrapped with a validator, e.g. \`zod.body({ json: ... })\` from @boon4681/giri/validators/zod.`,
                );
            }
            body.push(source.body);
        }

        if (source.query !== undefined) {
            if (!isGiriInputSchema(source.query)) {
                throw new RouteInputError(
                    `${source.label}: "query" must be wrapped with a validator, e.g. \`zod.query(...)\` from @boon4681/giri/validators/zod.`,
                );
            }
            query.push(source.query);
        }
    }

    const input: RouteInput = {};
    if (body.length > 0) {
        input.body = body;
    }
    if (query.length > 0) {
        input.query = query;
    }
    return input.body || input.query ? input : undefined;
}

const MIME_TO_CONTENT_TYPE: Record<string, BodyContentType> = {
    'application/json': 'json',
    'multipart/form-data': 'form',
    'application/x-www-form-urlencoded': 'urlencoded',
    'text/plain': 'text',
};

function contentTypeFromHeader(header: string | null): BodyContentType | undefined {
    if (!header) {
        return undefined;
    }
    const mime = header.split(';', 1)[0].trim().toLowerCase();
    return MIME_TO_CONTENT_TYPE[mime];
}

/** Flatten a `FormData` into a plain object, collapsing repeated fields into arrays. */
function formDataObject(form: FormData): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    form.forEach((value, key) => {
        const current = result[key];
        if (current === undefined) {
            result[key] = value;
        } else if (Array.isArray(current)) {
            current.push(value);
        } else {
            result[key] = [current, value];
        }
    });
    return result;
}

async function readRawBody(request: Request, contentType: BodyContentType): Promise<unknown> {
    const cloned = request.clone();
    if (contentType === 'json') {
        return cloned.json();
    }
    if (contentType === 'text') {
        return cloned.text();
    }
    return formDataObject(await cloned.formData());
}

function queryObject(url: URL): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of url.searchParams) {
        const current = result[key];
        if (current === undefined) {
            result[key] = value;
        } else if (Array.isArray(current)) {
            current.push(value);
        } else {
            result[key] = [current, value];
        }
    }
    return result;
}

/** Shallow-merge validated outputs from several owners; a single owner keeps its exact value. */
function mergeValidated(values: unknown[]): unknown {
    if (values.length === 1) {
        return values[0];
    }
    return Object.assign({}, ...values);
}

export async function prepareRequestInput(request: Request, input?: RouteInput): Promise<PreparedRequestInput> {
    const validated: ValidatedInput = {};

    if (input?.query && input.query.length > 0) {
        const query = queryObject(new URL(request.url));
        const values: unknown[] = [];
        for (const schema of input.query) {
            const result = await schema.validate(query);
            if (!result.ok) {
                return {
                    ok: false,
                    response: createTypedResponse(
                        { message: 'Invalid query parameters.', issues: result.issues },
                        400,
                        'json',
                    ),
                };
            }
            values.push(result.value);
        }
        validated.query = mergeValidated(values);
    }

    if (input?.body && input.body.length > 0) {
        // The set of acceptable content-types is the union across every body owner.
        const declared = [
            ...new Set(input.body.flatMap((schema) => Object.keys(schema.contents) as BodyContentType[])),
        ];
        const requested = contentTypeFromHeader(request.headers.get('content-type'));
        // Pick the type matching the request's content-type; fall back to JSON when the header is
        // missing/unrecognized but JSON is on offer (so header-less posts still work).
        const chosen: BodyContentType | undefined =
            requested && declared.includes(requested) ? requested : declared.includes('json') ? 'json' : undefined;

        if (!chosen) {
            return {
                ok: false,
                response: createTypedResponse(
                    { message: 'Unsupported media type.', issues: { accepted: declared } },
                    415,
                    'json',
                ),
            };
        }

        let rawBody: unknown;
        try {
            rawBody = await readRawBody(request, chosen);
        } catch (error) {
            return {
                ok: false,
                response: createTypedResponse(
                    { message: 'Invalid request body.', issues: error },
                    400,
                    'json',
                ),
            };
        }

        const values: unknown[] = [];
        for (const schema of input.body) {
            const contents = schema.contents as Partial<Record<BodyContentType, GiriInputSchema>>;
            const contentSchema = contents[chosen];
            // An owner that doesn't declare the chosen content-type simply contributes nothing.
            if (!contentSchema) {
                continue;
            }
            const result = await contentSchema.validate(rawBody);
            if (!result.ok) {
                return {
                    ok: false,
                    response: createTypedResponse(
                        { message: 'Invalid request body.', issues: result.issues },
                        400,
                        'json',
                    ),
                };
            }
            values.push(result.value);
        }

        const data = mergeValidated(values);
        validated.body = declared.length > 1 ? { type: chosen, data } : data;
    }

    return { ok: true, validated };
}

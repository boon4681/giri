import {
    type BodyContentType,
    type GiriBodySchema,
    type GiriInputSchema,
    type InputValidationResult,
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
 * Resolve route and middleware validators into the single input contract exposed by
 * `c.req.valid`. A target can only have one owner so validated data is never silently replaced.
 */
export function resolveRouteInput(sources: readonly RouteInputSource[]): RouteInput | undefined {
    const input: RouteInput = {};
    const owners: Partial<Record<keyof RouteInput, string>> = {};

    for (const source of sources) {
        if (source.body !== undefined) {
            if (!isGiriBodySchema(source.body)) {
                throw new Error(
                    `${source.label}: "body" must be wrapped with a validator, e.g. \`zod.body({ json: ... })\` from @boon4681/giri/validators/zod.`,
                );
            }
            if (input.body) {
                throw new Error(
                    `${source.label}: body validator conflicts with the body validator from ${owners.body}.`,
                );
            }
            input.body = source.body;
            owners.body = source.label;
        }

        if (source.query !== undefined) {
            if (!isGiriInputSchema(source.query)) {
                throw new Error(
                    `${source.label}: "query" must be wrapped with a validator, e.g. \`zod.query(...)\` from @boon4681/giri/validators/zod.`,
                );
            }
            if (input.query) {
                throw new Error(
                    `${source.label}: query validator conflicts with the query validator from ${owners.query}.`,
                );
            }
            input.query = source.query;
            owners.query = source.label;
        }
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

async function runValidation(
    schema: GiriInputSchema,
    value: unknown,
    label: string,
): Promise<InputValidationResult> {
    if (!isGiriInputSchema(schema)) {
        throw new Error(
            `giri: ${label} schema must be wrapped with a validator, e.g. \`export const ${label} = zod(...)\` from @boon4681/giri/validators/zod.`,
        );
    }
    return schema.validate(value);
}

export async function prepareRequestInput(request: Request, input?: RouteInput): Promise<PreparedRequestInput> {
    const validated: ValidatedInput = {};

    if (input?.query) {
        const query = queryObject(new URL(request.url));
        const result = await runValidation(input.query, query, 'query');
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
        validated.query = result.value;
    }

    if (input?.body) {
        const contents = input.body.contents as Record<BodyContentType, GiriInputSchema>;
        const declared = Object.keys(contents) as BodyContentType[];
        const requested = contentTypeFromHeader(request.headers.get('content-type'));
        // Pick the schema matching the request's content-type; fall back to JSON when the
        // header is missing/unrecognized but JSON is on offer (so header-less posts still work).
        const chosen: BodyContentType | undefined =
            requested && contents[requested] ? requested : contents.json ? 'json' : undefined;

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

        const result = await runValidation(contents[chosen], rawBody, 'body');
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

        validated.body = declared.length > 1 ? { type: chosen, data: result.value } : result.value;
    }

    return { ok: true, validated };
}

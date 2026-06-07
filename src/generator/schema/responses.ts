import ts from 'typescript';
import { createWalkContext, walkType, type JSONSchema } from './json-schema';

export interface ResponseSchema {
    /** Numeric HTTP status, or 'default' when the handler returns a non-literal status. */
    status: number | 'default';
    format: 'json' | 'text';
    schema: JSONSchema;
}

export interface RouteResponses {
    responses: ResponseSchema[];
    /** Statuses/returns the walker could not turn into a schema (e.g. a raw `Response`). */
    opaque: boolean;
    warnings: string[];
    $defs: Record<string, JSONSchema>;
}

function findHandleFunction(
    source: ts.SourceFile,
): ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | undefined {
    let found: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | undefined;

    const isExported = (node: ts.Node): boolean =>
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

    for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'handle' && isExported(statement)) {
            found = statement;
        }
        if (ts.isVariableStatement(statement) && isExported(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === 'handle' &&
                    declaration.initializer &&
                    (ts.isArrowFunction(declaration.initializer) ||
                        ts.isFunctionExpression(declaration.initializer))
                ) {
                    found = declaration.initializer;
                }
            }
        }
    }

    return found;
}

function collectReturnExpressions(
    fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): ts.Expression[] {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
        return [fn.body];
    }
    if (!fn.body) {
        return [];
    }

    const expressions: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
            return;
        }
        if (ts.isReturnStatement(node) && node.expression) {
            expressions.push(node.expression);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return expressions;
}

interface ResponseHit {
    status: number | 'default';
    format: 'json' | 'text';
    data: ts.Type;
}

function propertyType(
    checker: ts.TypeChecker,
    type: ts.Type,
    name: string,
    location: ts.Node,
): ts.Type | undefined {
    const symbol = checker.getPropertyOfType(type, name);
    return symbol ? checker.getTypeOfSymbolAtLocation(symbol, location) : undefined;
}

function isTypedResponse(checker: ts.TypeChecker, type: ts.Type): boolean {
    return Boolean(
        checker.getPropertyOfType(type, 'data') &&
        checker.getPropertyOfType(type, 'status') &&
        checker.getPropertyOfType(type, 'format'),
    );
}

/**
 * Read a `c.json(data, status?)` / `c.text(data, status?)` call directly. Reading the
 * status from the argument (default 200) sidesteps contextual typing: a `: Handle`
 * annotation otherwise widens an omitted status from its `= 200` default down to
 * `StatusCode`. Data still comes from the argument's own type.
 */
function readFromCall(checker: ts.TypeChecker, expression: ts.Expression): ResponseHit | undefined {
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
        return undefined;
    }
    const method = expression.expression.name.text;
    if (method !== 'json' && method !== 'text') {
        return undefined;
    }
    if (!isTypedResponse(checker, checker.getTypeAtLocation(expression))) {
        return undefined;
    }

    const [dataArg, statusArg] = expression.arguments;
    if (!dataArg) {
        return undefined;
    }

    let status: number | 'default' = 200;
    if (statusArg) {
        const statusType = checker.getTypeAtLocation(statusArg);
        status = statusType.isNumberLiteral() ? statusType.value : 'default';
    }

    return { status, format: method === 'text' ? 'text' : 'json', data: checker.getTypeAtLocation(dataArg) };
}

/** Fallback for non-`c.json` returns: read `{ data, status, format }` off the type itself. */
function readFromType(checker: ts.TypeChecker, type: ts.Type, location: ts.Node): ResponseHit | undefined {
    const dataType = propertyType(checker, type, 'data', location);
    const statusType = propertyType(checker, type, 'status', location);
    const formatType = propertyType(checker, type, 'format', location);
    if (!dataType || !statusType || !formatType) {
        return undefined;
    }

    const status = statusType.isNumberLiteral() ? statusType.value : 'default';
    const format = formatType.isStringLiteral() && formatType.value === 'text' ? 'text' : 'json';
    return { status, format, data: dataType };
}

function constituents(type: ts.Type): ts.Type[] {
    return type.isUnion() ? type.types : [type];
}

/**
 * Extract per-status response schemas for a route's `handle` export by typing each of
 * its return expressions and unwrapping giri's `TypedResponse<data, status, format>`.
 */
export function extractRouteResponses(program: ts.Program, file: string): RouteResponses {
    const result: RouteResponses = { responses: [], opaque: false, warnings: [], $defs: {} };
    const source = program.getSourceFile(file);
    if (!source) {
        return result;
    }

    const checker = program.getTypeChecker();
    const fn = findHandleFunction(source);
    if (!fn) {
        return result;
    }

    const ctx = createWalkContext(checker, fn);
    const byStatus = new Map<number | 'default', { format: 'json' | 'text'; schemas: JSONSchema[] }>();

    const record = (hit: ResponseHit): void => {
        const schema = walkType(hit.data, ctx);
        const bucket = byStatus.get(hit.status) ?? { format: hit.format, schemas: [] };
        bucket.schemas.push(schema);
        byStatus.set(hit.status, bucket);
    };

    for (const expression of collectReturnExpressions(fn)) {
        const fromCall = readFromCall(checker, expression);
        if (fromCall) {
            record(fromCall);
            continue;
        }

        let matched = false;
        for (const member of constituents(checker.getTypeAtLocation(expression))) {
            const hit = readFromType(checker, member, expression);
            if (hit) {
                record(hit);
                matched = true;
            }
        }
        if (!matched) {
            result.opaque = true;
        }
    }

    for (const [status, { format, schemas }] of byStatus) {
        const schema = schemas.length === 1 ? schemas[0] : { anyOf: schemas };
        result.responses.push({ status, format, schema });
    }
    result.responses.sort((a, b) => Number(a.status) - Number(b.status));
    result.warnings = ctx.warnings;
    result.$defs = ctx.defs;
    return result;
}

import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { glob } from 'tinyglobby';
import ts from 'typescript';
import type { HttpMethod } from './types';

const METHOD_ORDER: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
const METHOD_FROM_FILE = new Map<string, HttpMethod>(
    METHOD_ORDER.map((method) => [`+${method.toLowerCase()}`, method]),
);

export interface RouteParam {
    name: string;
    catchAll: boolean;
}

export interface ScannedRoute {
    method: HttpMethod;
    path: string;
    file: string;
    routeDir: string;
    routeSegments: string[];
    params: RouteParam[];
    /** The `+shared.ts` chain folder-cascading config. */
    sharedFiles: string[];
}

function normalizeSlashes(path: string): string {
    return path.split(sep).join('/');
}

function isRouteSourceFile(fileName: string): boolean {
    return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(fileName) && !fileName.endsWith('.d.ts');
}

function methodFromFile(fileName: string): HttpMethod | undefined {
    if (!isRouteSourceFile(fileName)) {
        return undefined;
    }
    const stem = fileName.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, '').toLowerCase();
    return METHOD_FROM_FILE.get(stem);
}

function hasExportModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) &&
        (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function hasDeclareModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) &&
        (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false);
}

function propertyName(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
        return node.text;
    }
    if (ts.isPropertyAccessExpression(node)) {
        return node.name.text;
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
        const argument = node.argumentExpression;
        if (ts.isStringLiteralLike(argument)) {
            return argument.text;
        }
    }
    return undefined;
}

function isExportsObject(node: ts.Expression): boolean {
    return ts.isIdentifier(node) && node.text === 'exports';
}

function isModuleExports(node: ts.Expression): boolean {
    return ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'module' &&
        node.name.text === 'exports';
}

function isCommonJsHandleTarget(node: ts.Expression): boolean {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
        return false;
    }
    return propertyName(node) === 'handle' &&
        (isExportsObject(node.expression) || isModuleExports(node.expression));
}

function objectExportsHandle(node: ts.Expression): boolean {
    if (!ts.isObjectLiteralExpression(node)) {
        return false;
    }
    return node.properties.some((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
            return property.name.text === 'handle';
        }
        return (
            (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
            propertyName(property.name) === 'handle'
        );
    });
}

function hasNamedHandleExport(source: ts.SourceFile): boolean {
    for (const statement of source.statements) {
        if (
            hasExportModifier(statement) &&
            !hasDeclareModifier(statement) &&
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === 'handle'
        ) {
            return true;
        }

        if (
            hasExportModifier(statement) &&
            !hasDeclareModifier(statement) &&
            ts.isVariableStatement(statement)
        ) {
            if (statement.declarationList.declarations.some(
                (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'handle',
            )) {
                return true;
            }
        }

        if (
            ts.isExportDeclaration(statement) &&
            !statement.isTypeOnly &&
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause)
        ) {
            if (statement.exportClause.elements.some(
                (element) => !element.isTypeOnly && element.name.text === 'handle',
            )) {
                return true;
            }
        }

        if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
            continue;
        }
        const assignment = statement.expression;
        if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
            continue;
        }
        if (
            isCommonJsHandleTarget(assignment.left) ||
            (isModuleExports(assignment.left) && objectExportsHandle(assignment.right))
        ) {
            return true;
        }
    }
    return false;
}

function parseSource(file: string): ts.SourceFile {
    return ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );
}

function parseDiagnostics(source: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
    return (
        source as ts.SourceFile & {
            parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
        }
    ).parseDiagnostics ?? [];
}

function formatSyntaxDiagnostic(diagnostic: ts.DiagnosticWithLocation): string {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} - error TS${diagnostic.code}: ${message}`;
}

/** Verify a TypeScript/JavaScript source file parses before accepting a watch update. */
export function assertSourceSyntax(file: string): void {
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file)) {
        return;
    }
    const diagnostics = parseDiagnostics(parseSource(file));
    if (diagnostics.length > 0) {
        throw new SyntaxError(diagnostics.map(formatSyntaxDiagnostic).join('\n'));
    }
}

/** Verify the route declares a named handle export without evaluating the module. */
export function assertRouteHandleExport(file: string): void {
    const source = parseSource(file);
    const diagnostics = parseDiagnostics(source);
    if (diagnostics.length > 0) {
        throw new SyntaxError(diagnostics.map(formatSyntaxDiagnostic).join('\n'));
    }
    if (!hasNamedHandleExport(source)) {
        throw new Error(`${file} must export a named handle function.`);
    }
}

function sharedFileIn(dir: string, cache?: Map<string, string | undefined>): string | undefined {
    if (cache?.has(dir)) {
        return cache.get(dir);
    }
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts']) {
        const file = join(dir, `+shared.${ext}`);
        if (existsSync(file)) {
            cache?.set(dir, file);
            return file;
        }
    }
    cache?.set(dir, undefined);
    return undefined;
}

function physicalRouteSegments(routesDir: string, routeDir: string): string[] {
    const rel = relative(routesDir, routeDir);
    if (!rel) {
        return [];
    }
    return normalizeSlashes(rel).split('/').filter(Boolean);
}

function urlSegment(segment: string): { value?: string; param?: RouteParam } {
    if (/^\(.+\)$/.test(segment)) {
        return {};
    }

    const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
    if (catchAll) {
        const name = catchAll[1];
        return {
            value: `:${name}{.*}`,
            param: { name, catchAll: true },
        };
    }

    const param = /^\[(.+)\]$/.exec(segment);
    if (param) {
        const name = param[1];
        return {
            value: `:${name}`,
            param: { name, catchAll: false },
        };
    }

    return { value: segment };
}

interface SegmentRank {
    /** 0 = static, 1 = dynamic param, 2 = catch-all. Lower matches more specifically. */
    rank: number;
    text: string;
}

function segmentRanks(segments: string[]): SegmentRank[] {
    const ranks: SegmentRank[] = [];
    for (const segment of segments) {
        const converted = urlSegment(segment);
        if (!converted.value) {
            continue;
        }
        if (converted.param?.catchAll) {
            ranks.push({ rank: 2, text: converted.param.name });
        } else if (converted.param) {
            ranks.push({ rank: 1, text: converted.param.name });
        } else {
            ranks.push({ rank: 0, text: converted.value });
        }
    }
    return ranks;
}

/** Order routes so more specific paths come before dynamic and catch-all ones at each segment. */
function compareRoutes(left: ScannedRoute, right: ScannedRoute): number {
    const leftRanks = segmentRanks(left.routeSegments);
    const rightRanks = segmentRanks(right.routeSegments);
    const shared = Math.min(leftRanks.length, rightRanks.length);

    for (let i = 0; i < shared; i++) {
        const a = leftRanks[i];
        const b = rightRanks[i];
        if (a.rank !== b.rank) {
            return a.rank - b.rank;
        }
        if (a.rank === 0 && a.text !== b.text) {
            return a.text.localeCompare(b.text);
        }
    }

    if (leftRanks.length !== rightRanks.length) {
        return leftRanks.length - rightRanks.length;
    }
    return METHOD_ORDER.indexOf(left.method) - METHOD_ORDER.indexOf(right.method);
}

export function pathFromSegments(segments: string[]): { path: string; params: RouteParam[] } {
    const pathSegments: string[] = [];
    const params: RouteParam[] = [];

    for (const segment of segments) {
        const converted = urlSegment(segment);
        if (converted.value) {
            pathSegments.push(converted.value);
        }
        if (converted.param) {
            params.push(converted.param);
        }
    }

    return {
        path: pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '/',
        params,
    };
}

/**
 * Every directory under `routesDir` (including itself), so `$types` can be generated for a
 * folder the moment it's created
 */
export async function scanRouteFolders(routesDir: string): Promise<string[]> {
    if (!existsSync(routesDir)) {
        return [];
    }
    const folders = [routesDir];
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== 'node_modules') {
                const full = join(dir, entry.name);
                folders.push(full);
                await walk(full);
            }
        }
    };
    await walk(routesDir);
    return folders;
}

/** Folder-derived params for any directory under `routesDir` (used for middleware `$types`). */
export function routeParamsForDir(routesDir: string, dir: string): RouteParam[] {
    return pathFromSegments(physicalRouteSegments(routesDir, dir)).params;
}

/** The ordered `+shared.ts` chain that applies to a directory. */
export function sharedFilesForDir(
    routesDir: string,
    dir: string,
    cache?: Map<string, string | undefined>,
): string[] {
    const segments = physicalRouteSegments(routesDir, dir);
    const dirs = [routesDir];

    let current = routesDir;
    for (const segment of segments) {
        current = join(current, segment);
        dirs.push(current);
    }

    return dirs.map((currentDir) => sharedFileIn(currentDir, cache)).filter((file): file is string => Boolean(file));
}

export async function scanRoutes(routesDir: string): Promise<ScannedRoute[]> {
    if (!existsSync(routesDir)) {
        return [];
    }

    const files = await glob('**/+*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}', {
        cwd: routesDir,
        absolute: true,
        onlyFiles: true,
    });

    const routes: ScannedRoute[] = [];
    const sharedCache = new Map<string, string | undefined>();

    for (const file of files) {
        const method = methodFromFile(basename(file));
        if (!method) {
            continue;
        }

        const routeDir = dirname(file);
        const routeSegments = physicalRouteSegments(routesDir, routeDir);
        const { path, params } = pathFromSegments(routeSegments);

        routes.push({
            method,
            path,
            file,
            routeDir,
            routeSegments,
            params,
            sharedFiles: sharedFilesForDir(routesDir, routeDir, sharedCache),
        });
    }

    return routes.sort(compareRoutes);
}

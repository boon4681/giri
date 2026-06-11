/**
 * Build the project's import graph from **source**, not from Node's `require.cache`.
 *
 * The watcher needs to know which routes (transitively) import a changed file so it can
 * rebuild just those. The require.cache only records edges for modules that were actually
 * evaluated at runtime, but `syncProject` resolves most routes statically and never `require`s
 * them - so those import edges are missing and a helper edit would fall back to a full resync.
 * Parsing the imports ourselves makes the graph independent of runtime evaluation.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { glob } from 'tinyglobby';
import { resolveAliasRequest } from '../app';
import type { GiriConfig } from '../types';
import type { ModuleGraph } from './module-loader';

const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_EXT = /\.(?:c|m)?jsx?$/;

const toSlash = (path: string): string => path.split(sep).join('/');

/** Resolve a module base (no/with extension) to a real file, trying extensions then `index.*`. */
function probeFile(base: string): string | undefined {
    if (existsSync(base) && statSync(base).isFile()) {
        return base;
    }
    for (const ext of RESOLVE_EXTS) {
        const candidate = base + ext;
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    for (const ext of RESOLVE_EXTS) {
        const candidate = join(base, `index${ext}`);
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/** Resolve one import specifier to an absolute project file, or `undefined` for bare/external. */
function resolveSpecifier(
    specifier: string,
    fromFile: string,
    alias: GiriConfig['alias'],
    cwd: string,
): string | undefined {
    let target: string;
    if (specifier.startsWith('.')) {
        target = resolve(dirname(fromFile), specifier);
    } else {
        const aliased = resolveAliasRequest(specifier, alias, cwd);
        if (aliased === undefined) {
            return undefined; // bare import (node_modules) - not part of the project graph
        }
        target = aliased;
    }

    const resolved = probeFile(target);
    if (resolved) {
        return resolved;
    }
    // A `.js`/`.mjs` specifier in TS source usually points at its `.ts` sibling.
    if (JS_EXT.test(target)) {
        return probeFile(target.replace(JS_EXT, ''));
    }
    return undefined;
}

/** Collect every static/dynamic import + `require()`/`export … from` specifier in a source file. */
function importSpecifiers(file: string): string[] {
    let source: ts.SourceFile;
    try {
        source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
    } catch {
        return [];
    }

    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            specifiers.push(node.moduleSpecifier.text);
        } else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            ts.isStringLiteralLike(node.moduleReference.expression)
        ) {
            specifiers.push(node.moduleReference.expression.text);
        } else if (ts.isCallExpression(node)) {
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const [first] = node.arguments;
            if ((isRequire || isDynamicImport) && first && ts.isStringLiteralLike(first)) {
                specifiers.push(first.text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return specifiers;
}

/**
 * Statically scan every project source file under `cwd` (skipping `node_modules` and the
 * generated `outDir`) and resolve its imports into a `dep -> importers` graph keyed on
 * forward-slash paths, matching what `collectDependents` consumes. Type-only imports are
 * included on purpose: a route's response schema can depend on an imported type.
 */
export async function buildImportGraph(
    config: Pick<GiriConfig, 'alias' | 'outDir'>,
    cwd: string,
): Promise<ModuleGraph> {
    const root = resolve(cwd);
    const outDir = resolve(root, config.outDir ?? '.giri') + sep;
    const outRel = relative(root, outDir).split(sep).join('/').replace(/\/$/, '');
    const files = await glob('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        ignore: ['**/node_modules/**', '**/.git/**', outRel ? `${outRel}/**` : '.giri/**'],
    });

    const importers = new Map<string, Set<string>>();
    const nodes = new Set<string>();
    for (const file of files) {
        if (file.startsWith(outDir)) {
            continue;
        }
        for (const specifier of importSpecifiers(file)) {
            const dep = resolveSpecifier(specifier, file, config.alias, root);
            if (!dep || dep.startsWith(outDir)) {
                continue;
            }
            const from = toSlash(file);
            const to = toSlash(dep);
            nodes.add(from);
            nodes.add(to);
            let set = importers.get(to);
            if (!set) {
                set = new Set();
                importers.set(to, set);
            }
            set.add(from);
        }
    }
    return { importers, nodes };
}

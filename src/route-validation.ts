import { readFileSync } from 'node:fs';
import ts from 'typescript';

function hasExportModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) &&
        (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function hasDeclareModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) &&
        (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false);
}

function propertyName(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
        return node.argumentExpression.text;
    }
    return undefined;
}

function isExportsObject(node: ts.Expression): boolean {
    return ts.isIdentifier(node) && node.text === 'exports';
}

function isModuleExports(node: ts.Expression): boolean {
    return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'module' && node.name.text === 'exports';
}

function isCommonJsHandleTarget(node: ts.Expression): boolean {
    return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        propertyName(node) === 'handle' && (isExportsObject(node.expression) || isModuleExports(node.expression));
}

function objectExportsHandle(node: ts.Expression): boolean {
    return ts.isObjectLiteralExpression(node) && node.properties.some((property) =>
        (ts.isShorthandPropertyAssignment(property) && property.name.text === 'handle') ||
        ((ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) && propertyName(property.name) === 'handle'),
    );
}

function hasNamedHandleExport(source: ts.SourceFile): boolean {
    for (const statement of source.statements) {
        if (hasExportModifier(statement) && !hasDeclareModifier(statement) &&
            ts.isFunctionDeclaration(statement) && statement.name?.text === 'handle') return true;
        if (hasExportModifier(statement) && !hasDeclareModifier(statement) && ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'handle')) return true;
        if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause &&
            ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some((element) => !element.isTypeOnly && element.name.text === 'handle')) return true;
        if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
        const assignment = statement.expression;
        if (assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            (isCommonJsHandleTarget(assignment.left) || (isModuleExports(assignment.left) && objectExportsHandle(assignment.right)))) return true;
    }
    return false;
}

function parseSource(file: string): ts.SourceFile {
    return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function diagnostics(source: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
    return (source as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
}

function assertDiagnostics(source: ts.SourceFile): void {
    const errors = diagnostics(source);
    if (errors.length === 0) return;
    throw new SyntaxError(errors.map((diagnostic) => {
        const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} - error TS${diagnostic.code}: ${message}`;
    }).join('\n'));
}

export function assertSourceSyntax(file: string): void {
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file)) return;
    assertDiagnostics(parseSource(file));
}

export function assertRouteHandleExport(file: string): void {
    const source = parseSource(file);
    assertDiagnostics(source);
    if (!hasNamedHandleExport(source)) throw new Error(`${file} must export a named handle function.`);
}

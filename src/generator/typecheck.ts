import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
    const message = `error TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    if (!diagnostic.file || diagnostic.start === undefined) {
        return message;
    }
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} - ${message}`;
}

/**
 * Type-check the project with its own `tsconfig.json`, the same result `tsc --noEmit` gives.
 * Returns one formatted line per error; empty when the project has no `tsconfig.json`.
 */
export function typecheckProject(cwd: string): string[] {
    const configPath = join(cwd, 'tsconfig.json');
    if (!existsSync(configPath)) {
        return [];
    }

    const diagnostics: ts.Diagnostic[] = [];
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true }, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            diagnostics.push(diagnostic);
        },
    });
    if (parsed) {
        diagnostics.push(...parsed.errors);
        const program = ts.createProgram({
            rootNames: parsed.fileNames,
            options: parsed.options,
            projectReferences: parsed.projectReferences,
        });
        diagnostics.push(...ts.getPreEmitDiagnostics(program));
    }

    return diagnostics
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
        .map(formatDiagnostic);
}

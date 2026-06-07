import type * as ts from 'typescript/lib/tsserverlibrary';
import { resolveGiriTypesImport } from './typescript-plugin-core';

type ResolveModuleNames = NonNullable<ts.LanguageServiceHost['resolveModuleNames']>;

function init(modules: { typescript: typeof ts }): ts.server.PluginModule {
    return {
        create(info) {
            const host = info.languageServiceHost as ts.LanguageServiceHost & {
                resolveModuleNames?: ResolveModuleNames;
            };
            const originalResolveModuleNames = host.resolveModuleNames?.bind(host);

            host.resolveModuleNames = (moduleNames, containingFile, ...rest) => {
                const originalResults = originalResolveModuleNames
                    ? originalResolveModuleNames(moduleNames, containingFile, ...rest)
                    : undefined;

                return moduleNames.map((moduleName, index) => {
                    const resolved = resolveGiriTypesImport({
                        moduleName,
                        containingFile,
                        projectDir: info.project.getCurrentDirectory(),
                        rootDirs: info.project.getCompilerOptions().rootDirs,
                        fileExists: info.serverHost.fileExists?.bind(info.serverHost),
                    });

                    if (resolved) {
                        return {
                            resolvedFileName: resolved,
                            extension: modules.typescript.Extension.Dts,
                            isExternalLibraryImport: false,
                        };
                    }

                    if (originalResults) {
                        return originalResults[index];
                    }

                    return modules.typescript.resolveModuleName(
                        moduleName,
                        containingFile,
                        info.project.getCompilerOptions(),
                        modules.typescript.sys,
                    ).resolvedModule;
                });
            };

            return info.languageService;
        },
    };
}

export = init;

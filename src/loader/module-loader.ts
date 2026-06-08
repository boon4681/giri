/**
 * Unproven method on (other javascript runtime) to build do module-graph by using NodeJS `require.cache`: each module records
 * its `children` and reflects the *previous* build
 */
import { join, resolve, sep } from 'node:path';

export interface ModuleGraph {
    importers: Map<string, Set<string>>;
    nodes: Set<string>;
}

const toSlash = (path: string): string => path.split(sep).join('/');

const isProjectModule = (id: string, root: string): boolean => {
    return id.startsWith(root) && !id.includes(`${sep}node_modules${sep}`) && !id.includes(`${sep}.giri${sep}`);
}

export const buildModuleGraph = (cwd: string): ModuleGraph => {
    const root = resolve(cwd) + sep;
    const importers = new Map<string, Set<string>>();
    const nodes = new Set<string>();
    for (const id of Object.keys(require.cache)) {
        if (!isProjectModule(id, root)) {
            continue;
        }
        const mod = require.cache[id];
        if (!mod) {
            continue;
        }
        nodes.add(toSlash(id));
        for (const child of mod.children) {
            if (!isProjectModule(child.id, root)) {
                continue;
            }
            nodes.add(toSlash(child.id));
            const dep = toSlash(child.id);
            let set = importers.get(dep);
            if (!set) {
                set = new Set();
                importers.set(dep, set);
            }
            set.add(toSlash(id));
        }
    }
    return { importers, nodes };
};

export const collectDependents = (graph: ModuleGraph, start: string): Set<string> => {
    const out = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
        const current = stack.pop()!;
        for (const importer of graph.importers.get(current) ?? []) {
            if (!out.has(importer)) {
                out.add(importer);
                stack.push(importer);
            }
        }
    }
    return out;
};

export const purgeModules = (files: Set<string>): void => {
    for (const id of Object.keys(require.cache)) {
        if (files.has(toSlash(id))) {
            delete require.cache[id];
        }
    }
};

/**
 * Drop every cached module under the project root (skipping `node_modules` and `.giri`).
 */
export const purgeProjectModules = (cwd: string): void => {
    const root = resolve(cwd) + sep;
    for (const id of Object.keys(require.cache)) {
        if (isProjectModule(id, root)) {
            delete require.cache[id];
        }
    }
};

export const purgeGeneratedModules = (outDir: string): void => {
    const root = resolve(outDir) + sep;
    for (const id of Object.keys(require.cache)) {
        if (resolve(id).startsWith(root)) {
            delete require.cache[id];
        }
    }
};
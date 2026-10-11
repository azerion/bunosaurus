/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {posixPath} from '@docusaurus/utils';
import type {BuildMetafile} from 'bun';

/**
 * Replaces the react-loadable-ssr-addon manifest: tells the SSG which client
 * assets each page needs, based on the modules rendered for that page.
 * All file paths are relative to the output dir (prefixed with baseUrl later).
 */
export type ClientManifest = {
  entry: {js: string[]; css: string[]};
  /** module path (as written in the registry) -> JS files to preload */
  modules: {[modulePath: string]: string[]};
  /** URL of the ClientChunkMap file, used for prefetching */
  chunkMapUrl?: string;
};

/**
 * Used by the client to prefetch route chunks, see client/docusaurus.ts
 * Compact format: chunk names map to indexes in the files array.
 */
export type ClientChunkMap = {
  files: string[];
  chunks: {[chunkName: string]: number[]};
};

// Bun metafile paths are relative to the cwd, except for namespaced modules
function normalizeMetaPath(metaPath: string): string {
  if (/^[\w-]{2,}:/.test(metaPath)) {
    return metaPath;
  }
  return path.resolve(metaPath);
}

function normalizeOutputPath(outputPath: string): string {
  return posixPath(outputPath).replace(/^\.\//, '');
}

export function createClientManifest({
  metafile,
  clientEntryPath,
  dynamicImports,
  registry,
}: {
  metafile: BuildMetafile;
  clientEntryPath: string;
  /** registry module path (import specifier) -> resolved metafile key */
  dynamicImports: Map<string, string>;
  /** chunk name -> registry module path */
  registry: {[chunkName: string]: string};
}): {manifest: ClientManifest; chunkMap: ClientChunkMap} {
  const outputs = Object.entries(metafile.outputs);

  // Entry point (input path) -> output JS file
  const outputByEntryPoint = new Map<string, string>();
  outputs.forEach(([outputPath, output]) => {
    if (output.entryPoint && outputPath.endsWith('.js')) {
      outputByEntryPoint.set(normalizeMetaPath(output.entryPoint), outputPath);
    }
  });

  function staticClosure(outputPath: string, result = new Set<string>()) {
    if (result.has(outputPath)) {
      return result;
    }
    result.add(outputPath);
    metafile.outputs[outputPath]?.imports.forEach((imported) => {
      if (imported.kind === 'import-statement') {
        staticClosure(normalizeImportPath(imported.path), result);
      }
    });
    return result;
  }

  // Imports are relative to the outdir, like output keys
  function normalizeImportPath(importPath: string): string {
    return importPath.startsWith('./') ? importPath : `./${importPath}`;
  }

  const entryOutputPath = outputByEntryPoint.get(path.resolve(clientEntryPath));
  if (!entryOutputPath) {
    throw new Error(
      `Docusaurus Bug: client entry output not found in Bun metafile for ${clientEntryPath}`,
    );
  }
  const entryOutput = metafile.outputs[entryOutputPath]!;
  const entryFiles = staticClosure(entryOutputPath);

  function getModuleFiles(modulePath: string): string[] {
    const key = dynamicImports.get(modulePath);
    const outputPath = key ? outputByEntryPoint.get(key) : undefined;
    if (!outputPath) {
      return [];
    }
    return [...staticClosure(outputPath)]
      .filter((file) => !entryFiles.has(file))
      .map(normalizeOutputPath);
  }

  const modules: ClientManifest['modules'] = {};
  dynamicImports.forEach((_key, modulePath) => {
    modules[modulePath] = getModuleFiles(modulePath);
  });

  const files: string[] = [];
  const fileIndexes = new Map<string, number>();
  const chunks: ClientChunkMap['chunks'] = {};
  Object.entries(registry).forEach(([chunkName, modulePath]) => {
    chunks[chunkName] = (modules[modulePath] ?? []).map((file) => {
      let index = fileIndexes.get(file);
      if (index === undefined) {
        index = files.length;
        files.push(file);
        fileIndexes.set(file, index);
      }
      return index;
    });
  });

  return {
    manifest: {
      entry: {
        js: [normalizeOutputPath(entryOutputPath)],
        css: entryOutput.cssBundle
          ? [normalizeOutputPath(entryOutput.cssBundle)]
          : [],
      },
      modules,
    },
    chunkMap: {files, chunks},
  };
}

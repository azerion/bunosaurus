/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {posixPath} from '@docusaurus/utils';
import type {BuildMetafile, BuildOutput} from 'bun';

// Dev server hot updates
//
// Bun chunk file names contain a hash that changes when the content of the
// chunk or of the chunks it imports changes. The route registry, bundled in
// the entry chunk, references the chunks of all routes: editing any route
// changes the entry content, and the hash of all the chunks importing the
// entry. Browsers would have to load new instances of all these chunks.
//
// In dev, we rename chunks with an ID that only depends on their identity
// (the module they are created for, or the modules they contain), so that
// URLs remain stable across rebuilds. Browsers re-import the chunks of updated
// route modules with a cache-busting query, which creates new instances of
// these chunks only, all the other modules keep their existing instances.

type DevOutputFile = {
  contentHash: string;
  /** Modules (metafile inputs) bundled in this file */
  inputs: string[];
};

export type DevBuildSnapshot = {
  /** Stable JS output path (relative to the outdir) -> file info */
  files: Map<string, DevOutputFile>;
  entryPath: string;
  cssPath: string | undefined;
  cssHash: string | undefined;
  /** Registry module path -> stable JS output path of its chunk */
  modules: Map<string, string>;
};

export type HotUpdate =
  | {type: 'none'}
  | {type: 'reload'; reason: string}
  | {
      type: 'hot';
      /** Registry module path -> URL path (relative) of its updated chunk */
      modules: {[modulePath: string]: string};
      cssChanged: boolean;
    };

// Bun metafile paths are relative to the cwd, except for namespaced modules
function normalizeMetaPath(metaPath: string): string {
  if (/^[\w-]{2,}:/.test(metaPath)) {
    return metaPath;
  }
  return path.resolve(metaPath);
}

// Output keys and paths are relative to the outdir, sometimes with "./"
function normalizeOutputPath(outputPath: string): string {
  return posixPath(outputPath).replace(/^\.\//, '');
}

const ChunkHashRegExp = /\.([a-z0-9]{8})\.js(?:\.map)?$/;
// Chunk hashes appear in file names (".<hash>.js") and string literals
const HashTokenRegExp = /(?<=[."])[a-z0-9]{8}(?=[."])/g;

function stableId(identity: string): string {
  return Bun.hash(identity).toString(36).padStart(8, '0').slice(-8);
}

function contentHash(content: string | Uint8Array): string {
  return Bun.hash(content).toString(36);
}

/**
 * Renames the chunks of an in-memory dev build with stable IDs, writes the
 * files that changed since the previous build, and returns the snapshot of the
 * build, used to compute hot updates.
 */
export async function writeDevBuildOutput({
  output,
  outDir,
  clientEntryPath,
  dynamicImports,
  writtenFiles,
}: {
  output: BuildOutput;
  outDir: string;
  clientEntryPath: string;
  /** Registry module path (import specifier) -> resolved metafile key */
  dynamicImports: Map<string, string>;
  /** Output path -> content hash of the files already written to disk */
  writtenFiles: Map<string, string>;
}): Promise<DevBuildSnapshot> {
  const metafile: BuildMetafile = output.metafile!;
  const metaOutputs = new Map(
    Object.entries(metafile.outputs).map(([key, metaOutput]) => [
      normalizeOutputPath(key),
      metaOutput,
    ]),
  );

  // Old chunk hash -> stable ID
  const ids = new Map<string, string>();
  const usedIds = new Set<string>();
  metaOutputs.forEach((metaOutput, outputPath) => {
    const hash = outputPath.match(ChunkHashRegExp)?.[1];
    if (!hash || !outputPath.endsWith('.js')) {
      return;
    }
    const identity = metaOutput.entryPoint
      ? normalizeMetaPath(metaOutput.entryPoint)
      : Object.keys(metaOutput.inputs).map(normalizeMetaPath).sort().join('\n');
    let id = stableId(identity);
    // Very unlikely, but 2 chunks must not get the same name
    for (let i = 1; usedIds.has(id); i += 1) {
      id = stableId(`${identity}\n${i}`);
    }
    usedIds.add(id);
    ids.set(hash, id);
  });

  const renamePath = (outputPath: string) =>
    outputPath.replace(ChunkHashRegExp, (match, hash: string) =>
      match.replace(hash, ids.get(hash) ?? hash),
    );

  const files = new Map<string, DevOutputFile>();
  const stablePaths = new Map<string, string>();
  let entryPath: string | undefined;
  let cssPath: string | undefined;
  let cssHash: string | undefined;

  await Promise.all(
    output.outputs.map(async (artifact) => {
      const outputPath = normalizeOutputPath(artifact.path);
      const stablePath = renamePath(outputPath);
      stablePaths.set(outputPath, stablePath);
      let content: string | Uint8Array;
      if (/\.js(?:\.map)?$/.test(outputPath)) {
        content = (await artifact.text()).replace(
          HashTokenRegExp,
          (token) => ids.get(token) ?? token,
        );
      } else {
        content = new Uint8Array(await artifact.arrayBuffer());
      }
      const hash = contentHash(content);
      if (writtenFiles.get(stablePath) !== hash) {
        await Bun.write(path.join(outDir, stablePath), content);
        writtenFiles.set(stablePath, hash);
      }
      const metaOutput = metaOutputs.get(outputPath);
      if (outputPath.endsWith('.js') && metaOutput) {
        files.set(stablePath, {
          contentHash: hash,
          inputs: Object.keys(metaOutput.inputs).map(normalizeMetaPath).sort(),
        });
        if (
          metaOutput.entryPoint &&
          normalizeMetaPath(metaOutput.entryPoint) ===
            path.resolve(clientEntryPath)
        ) {
          entryPath = stablePath;
          if (metaOutput.cssBundle) {
            cssPath = normalizeOutputPath(metaOutput.cssBundle);
          }
        }
      }
    }),
  );
  if (!entryPath) {
    throw new Error(
      `Docusaurus Bug: client entry output not found in Bun metafile for ${clientEntryPath}. Metafile entry points: ${[
        ...metaOutputs.values(),
      ]
        .map((metaOutput) => metaOutput.entryPoint)
        .filter(Boolean)
        .join(', ')}`,
    );
  }
  if (cssPath) {
    cssHash = writtenFiles.get(stablePaths.get(cssPath) ?? cssPath);
  }

  const outputByEntryPoint = new Map<string, string>();
  metaOutputs.forEach((metaOutput, outputPath) => {
    if (metaOutput.entryPoint && outputPath.endsWith('.js')) {
      outputByEntryPoint.set(
        normalizeMetaPath(metaOutput.entryPoint),
        stablePaths.get(outputPath) ?? outputPath,
      );
    }
  });
  const modules = new Map<string, string>();
  dynamicImports.forEach((key, modulePath) => {
    const outputPath = outputByEntryPoint.get(key);
    if (outputPath) {
      modules.set(modulePath, outputPath);
    }
  });

  return {files, entryPath, cssPath, cssHash, modules};
}

function describeInput(input: string): string {
  const filePath = input.replace(/^[\w-]{2,}:/, '').split('?')[0]!;
  return posixPath(path.relative(process.cwd(), filePath));
}

/**
 * Computes the update to apply in browsers running the previous build.
 *
 * Browsers can only hot-update the chunks of registry modules (route
 * components, MDX content, route data...): the client re-imports these chunks
 * and re-creates the route components using them. This is only safe when all
 * the other modules keep their existing instances, otherwise we reload.
 */
export function computeHotUpdate(
  prev: DevBuildSnapshot | undefined,
  next: DevBuildSnapshot,
): HotUpdate {
  if (!prev) {
    return {type: 'reload', reason: 'initial build'};
  }
  const routeChunks = new Map<string, string>();
  for (const [modulePath, outputPath] of next.modules) {
    if (!prev.modules.has(modulePath)) {
      return {type: 'reload', reason: `new route module ${modulePath}`};
    }
    routeChunks.set(outputPath, modulePath);
  }

  const changedModules: {[modulePath: string]: string} = {};
  const updatedFiles = new Set<string>();
  for (const [outputPath, file] of next.files) {
    const prevFile = prev.files.get(outputPath);
    if (!prevFile || prevFile.contentHash === file.contentHash) {
      continue;
    }
    const modulePath = routeChunks.get(outputPath);
    if (!modulePath) {
      return {
        type: 'reload',
        reason:
          outputPath === next.entryPath
            ? 'app entry changed'
            : `shared chunk changed (${outputPath})`,
      };
    }
    changedModules[modulePath] = `${outputPath}?t=${file.contentHash}`;
    updatedFiles.add(outputPath);
  }

  // New chunks are loaded as new module instances: they must not contain
  // modules that the browser may have loaded from other chunks
  const prevOwners = new Map<string, string>();
  prev.files.forEach((file, outputPath) => {
    file.inputs.forEach((input) => prevOwners.set(input, outputPath));
  });
  for (const [outputPath, file] of next.files) {
    if (prev.files.has(outputPath)) {
      continue;
    }
    for (const input of file.inputs) {
      const prevOwner = prevOwners.get(input);
      if (prevOwner && !updatedFiles.has(prevOwner)) {
        return {
          type: 'reload',
          reason: `module moved to another chunk (${describeInput(input)})`,
        };
      }
    }
  }

  const cssChanged = prev.cssHash !== next.cssHash;
  if (Object.keys(changedModules).length === 0 && !cssChanged) {
    return {type: 'none'};
  }
  return {type: 'hot', modules: changedModules, cssChanged};
}

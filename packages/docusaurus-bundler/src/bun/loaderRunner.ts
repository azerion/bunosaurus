/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {createHash} from 'node:crypto';

/**
 * A Webpack loader reference, as found in "module.rules[].use"
 */
export type LoaderItem = {
  loader: string;
  options?: unknown;
};

type LoaderResult = string | Buffer;

type LoaderFunction = ((
  this: unknown,
  content: LoaderResult,
  sourceMap?: unknown,
  meta?: unknown,
) => LoaderResult | void | Promise<LoaderResult | void>) & {raw?: boolean};

const loaderModuleCache = new Map<string, LoaderFunction>();

function loadLoaderModule(loader: string): LoaderFunction {
  let fn = loaderModuleCache.get(loader);
  if (!fn) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(loader) as LoaderFunction | {default: LoaderFunction};
    fn = typeof mod === 'function' ? mod : mod.default;
    if (typeof fn !== 'function') {
      throw new Error(`Webpack loader "${loader}" doesn't export a function`);
    }
    loaderModuleCache.set(loader, fn);
  }
  return fn;
}

function parseLoaderOptions(options: unknown): unknown {
  // Inline loaders pass options as a query string
  if (typeof options === 'string') {
    const query = options.startsWith('?') ? options.slice(1) : options;
    if (query.startsWith('{')) {
      return JSON.parse(query);
    }
    return Object.fromEntries(new URLSearchParams(query));
  }
  return options ?? {};
}

export type RunLoadersParams = {
  loaders: LoaderItem[];
  resourcePath: string;
  resourceQuery: string;
  content: Buffer;
  compilerName: 'client' | 'server';
  mode: 'production' | 'development';
  rootContext: string;
  onDependency?: (file: string) => void;
  onWarning?: (warning: Error) => void;
  onEmitFile?: (name: string, content: string | Buffer) => void;
};

/**
 * Runs a chain of Webpack loaders (right to left), providing the subset of the
 * Webpack LoaderContext API that loaders commonly rely on.
 * This lets us keep using the loaders that plugins declare in
 * configureWebpack() (MDX, blog truncation, SVGR...) with the Bun bundler.
 */
export async function runLoaders({
  loaders,
  resourcePath,
  resourceQuery,
  content,
  compilerName,
  mode,
  rootContext,
  onDependency,
  onWarning,
  onEmitFile,
}: RunLoadersParams): Promise<string | Buffer> {
  let result: LoaderResult = content;
  let sourceMap: unknown;
  let meta: unknown;

  for (let i = loaders.length - 1; i >= 0; i -= 1) {
    const item = loaders[i]!;
    const fn = loadLoaderModule(item.loader);
    const options = parseLoaderOptions(item.options);
    const input: LoaderResult =
      fn.raw || typeof result !== 'object'
        ? result
        : (result as Buffer).toString('utf8');

    const output = await new Promise<{
      content: LoaderResult;
      sourceMap?: unknown;
      meta?: unknown;
    }>((resolve, reject) => {
      let isAsync = false;
      let done = false;
      const callback = (
        error: Error | null | undefined,
        resultContent?: LoaderResult,
        resultMap?: unknown,
        resultMeta?: unknown,
      ) => {
        if (done) {
          return;
        }
        done = true;
        if (error) {
          reject(error);
        } else {
          resolve({
            content: resultContent ?? '',
            sourceMap: resultMap,
            meta: resultMeta,
          });
        }
      };

      const context = {
        version: 2,
        mode,
        target: compilerName === 'server' ? 'node' : 'web',
        sourceMap: false,
        resource: `${resourcePath}${resourceQuery}`,
        resourcePath,
        resourceQuery,
        resourceFragment: '',
        context: path.dirname(resourcePath),
        rootContext,
        loaders: loaders.map((l) => ({...l, request: l.loader})),
        loaderIndex: i,
        query: options,
        // Used by Docusaurus loaders to know which bundle they're compiling
        _compiler: {name: compilerName},
        getOptions: () => options,
        async: () => {
          isAsync = true;
          return callback;
        },
        callback: (...args: Parameters<typeof callback>) => {
          isAsync = true;
          callback(...args);
        },
        cacheable: () => {},
        addDependency: (file: string) => onDependency?.(file),
        dependency: (file: string) => onDependency?.(file),
        addContextDependency: () => {},
        addMissingDependency: () => {},
        addBuildDependency: () => {},
        emitWarning: (warning: Error) => onWarning?.(warning),
        emitError: (error: Error) => onWarning?.(error),
        emitFile: (name: string, fileContent: string | Buffer) =>
          onEmitFile?.(name, fileContent),
        getLogger: () => console,
        // cspell:ignore absolutify
        utils: {
          absolutify: (ctx: string, request: string) =>
            path.resolve(ctx, request),
          contextify: (ctx: string, request: string) =>
            path.relative(ctx, request),
          createHash: (algorithm?: string) =>
            createHash(algorithm === 'xxhash64' ? 'md5' : (algorithm ?? 'md5')),
        },
      };

      try {
        const returned = fn.call(context, input, sourceMap, meta);
        if (
          returned &&
          typeof (returned as Promise<unknown>).then === 'function'
        ) {
          (returned as Promise<LoaderResult | void>).then(
            (value) => {
              if (!isAsync) {
                callback(null, value ?? '');
              }
            },
            (error: Error) => callback(error),
          );
        } else if (!isAsync) {
          callback(null, (returned as LoaderResult | undefined) ?? '');
        }
      } catch (error) {
        callback(error as Error);
      }
    });

    result = output.content;
    sourceMap = output.sourceMap;
    meta = output.meta;
  }

  return result;
}

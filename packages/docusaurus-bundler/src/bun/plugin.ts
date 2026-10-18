/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {fs, pathExists} from '@docusaurus/fs';
import {runLoaders, type LoaderItem} from './loaderRunner';
import {
  isAssetLoader,
  resolveRuleLoaders,
  type CompatRule,
  type ContextReplacement,
} from './webpackCompat';
import {isAssetPath, type AssetEmitter, type AssetFolder} from './assets';
import {replaceNewURLs} from './newURL';
import type {LoaderCache} from './loaderCache';
import type {BunPlugin, OnResolveArgs, OnResolveResult} from 'bun';
import type {AcceptedPlugin} from 'postcss';

// Extensions tried when resolving a request without extension
const ResolveExtensions = [
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
];

const LoaderNamespace = 'docusaurus-loader';
const AssetNamespace = 'docusaurus-asset';
const TextNamespace = 'docusaurus-text';
const TextParam = 'docusaurus-text';

// Bun doesn't give access to import attributes in onResolve, and drops them
// for modules resolved by plugins. For the code we generate (MDX...), we turn
// text imports into a query param handled by our plugin.
const TextImportRegExp =
  /(from\s*)(['"])([^'"]+)\2(\s*with\s*\{\s*type\s*:\s*['"]text['"]\s*\})/g;

function getJSLoader(filePath: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  if (/\.[cm]?ts$/.test(filePath)) {
    return 'ts';
  }
  if (filePath.endsWith('.tsx')) {
    return 'tsx';
  }
  // Docusaurus allows JSX in .js files
  return 'jsx';
}

function rewriteTextImports(code: string): string {
  if (!code.includes('text')) {
    return code;
  }
  return code.replace(
    TextImportRegExp,
    (_match, from: string, quote: string, request: string) =>
      `${from}${quote}${request}${request.includes('?') ? '&' : '?'}${TextParam}${quote}`,
  );
}
const ChainParam = '__docusaurus_chain';

// Query param of asset requests created with createAssetRequest()
// (@docusaurus/utils): "!./img.png?docusaurus-asset=image"
const AssetRequestParam = 'docusaurus-asset';
// Internal asset request type for new URL('./img.png', import.meta.url)
const URLAssetRequestType = 'url';
// Our asset namespace paths keep a folder override in a query param
const AssetFolderParam = 'docusaurus-asset-folder';

function getAssetRequestFolder(resourceQuery: string): AssetFolder | undefined {
  const type = new URLSearchParams(resourceQuery.slice(1)).get(
    AssetRequestParam,
  );
  switch (type) {
    case 'image':
    case 'image-file':
      return 'images';
    case 'file':
      return 'files';
    default:
      return undefined;
  }
}

// Webpack-like RelativeURL constructor, see relativeURL.ts
const RelativeURLModulePath = require.resolve('./relativeURL');

export type DocusaurusBunPluginOptions = {
  isServer: boolean;
  mode: 'production' | 'development';
  siteDir: string;
  /** Dirs used to resolve absolute "/img/x.png" URLs in CSS files */
  rootDirs: string[];
  aliases: {[alias: string]: string};
  /**
   * Packages always resolved from the site dir, to ensure a single copy
   * (React...), even for files outside the site dir (ex: monorepo docs)
   */
  sitePackages: string[];
  rules: CompatRule[];
  contextReplacements: ContextReplacement[];
  /** PostCSS plugins, from the configurePostCss() lifecycle */
  postCssPlugins: unknown[];
  assetEmitter: AssetEmitter;
  loaderCache?: LoaderCache;
  /** Called for every resolved dynamic import, used to build manifests */
  onDynamicImport?: (params: {
    importer: string;
    specifier: string;
    /** Path as it appears in Bun metafile entry points */
    key: string;
  }) => void;
  onWarning?: (warning: Error) => void;
};

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitQuery(request: string): [string, string] {
  const index = request.indexOf('?');
  return index === -1
    ? [request, '']
    : [request.slice(0, index), request.slice(index)];
}

// Removes our internal chain marker from a loader namespace path
function parseLoaderPath(loaderPath: string): {
  resourcePath: string;
  resourceQuery: string;
  chainId: number;
} {
  const [resourcePath, query] = splitQuery(loaderPath);
  const params = new URLSearchParams(query.slice(1));
  const chainId = Number(params.get(ChainParam));
  params.delete(ChainParam);
  const rest = params.toString();
  return {resourcePath, resourceQuery: rest ? `?${rest}` : '', chainId};
}

function importerPath(args: OnResolveArgs): string {
  // Importers from our own namespaces may contain a query string
  return splitQuery(args.importer)[0];
}

const CSSRegExp = /\.css$/i;

function isPathRequest(request: string): boolean {
  return (
    request.startsWith('./') ||
    request.startsWith('../') ||
    request === '.' ||
    request === '..' ||
    path.isAbsolute(request)
  );
}

/**
 * Loader execution stats (count, cumulated wall time), for perf debugging
 */
export const loaderStats = {count: 0, time: 0};

export function createDocusaurusBunPlugin(
  options: DocusaurusBunPluginOptions,
): BunPlugin {
  const {aliases, rules, isServer, assetEmitter} = options;

  // Webpack alias semantics: "key" matches "key" and "key/*", "key$" is exact
  const exactAliases = new Map<string, string>();
  const prefixAliases: [string, string][] = [];
  Object.entries(aliases).forEach(([key, value]) => {
    if (key.endsWith('$')) {
      exactAliases.set(key.slice(0, -1), value);
    } else {
      exactAliases.set(key, value);
      prefixAliases.push([key, value]);
    }
  });
  // Longest prefix first, so that @theme/A/B wins over @theme/A
  prefixAliases.sort((a, b) => b[0].length - a[0].length);

  function applyAlias(request: string): string | undefined {
    const exact = exactAliases.get(request);
    if (exact !== undefined) {
      return exact;
    }
    for (const [key, value] of prefixAliases) {
      if (request.startsWith(`${key}/`)) {
        return value + request.slice(key.length);
      }
    }
    return undefined;
  }

  // Loader chains are registered at resolution time, and referenced by id
  const chains: LoaderItem[][] = [];
  function getChainId(loaders: LoaderItem[]): number {
    const index = chains.findIndex(
      (chain) =>
        chain.length === loaders.length &&
        chain.every((item, i) => item === loaders[i]),
    );
    if (index !== -1) {
      return index;
    }
    chains.push(loaders);
    return chains.length - 1;
  }

  async function resolveFile(
    request: string,
    resolveDir: string,
  ): Promise<string | null> {
    try {
      return Bun.resolveSync(request, resolveDir);
    } catch {
      // Bun's resolver caches directory entries per process, and may not see
      // files created after a directory was first read: in a localized build,
      // the generated files of a locale are created after the previous locale
      // was bundled (observed on Windows)
      if (path.isAbsolute(request)) {
        for (const candidate of [
          request,
          ...ResolveExtensions.map((ext) => `${request}${ext}`),
        ]) {
          if (
            (await pathExists(candidate)) &&
            (await fs.stat(candidate)).isFile()
          ) {
            return candidate;
          }
        }
      }
      // Absolute URLs in CSS are resolved against static dirs (resolve.roots)
      if (request.startsWith('/')) {
        for (const rootDir of options.rootDirs) {
          const candidate = path.join(rootDir, request);
          if (await pathExists(candidate)) {
            return candidate;
          }
        }
      }
      return null;
    }
  }

  async function resolveAsset(
    filePath: string,
    importer: string,
    folder?: AssetFolder,
  ): Promise<OnResolveResult> {
    // CSS files reference assets by URL: emit and externalize them
    if (CSSRegExp.test(importer)) {
      const asset = await assetEmitter.getAsset(filePath, folder);
      return {path: asset.cssUrl, external: true};
    }
    return {
      path: folder ? `${filePath}?${AssetFolderParam}=${folder}` : filePath,
      namespace: AssetNamespace,
    };
  }

  /**
   * Bun doesn't handle new URL('./img.png', import.meta.url): we turn it into
   * a request for the asset URL, like Webpack with "javascript.url: relative".
   * The "!" prefix skips the module rules: assets referenced this way are never
   * transformed by plugins (SVGR, ideal-image...).
   */
  function rewriteNewURLs(code: string): string {
    return replaceNewURLs(code, (request) => {
      // Absolute URLs (https:, data:...) are not assets
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(request)) {
        return undefined;
      }
      // URL semantics: "img.png" is relative, unless it's an alias
      const [requestPath, requestQuery] = splitQuery(request);
      const relativeRequest =
        isPathRequest(requestPath) || applyAlias(requestPath) !== undefined
          ? requestPath
          : `./${requestPath}`;
      const query = `${requestQuery ? `${requestQuery}&` : '?'}${AssetRequestParam}=${URLAssetRequestType}`;
      return `new (require(${JSON.stringify(
        RelativeURLModulePath,
      )}).RelativeURL)(require(${JSON.stringify(
        `!${relativeRequest}${query}`,
      )}))`;
    });
  }

  function rewriteSourceCode(code: string): string {
    return rewriteNewURLs(rewriteTextImports(code));
  }

  async function resolveInlineLoaders(
    args: OnResolveArgs,
  ): Promise<OnResolveResult | undefined> {
    // Webpack inline loaders syntax: "!loader1?opts!loader2!./resource"
    // The optional "matchResource!=!" prefix is irrelevant for us
    const request = args.path.includes('!=!')
      ? args.path.slice(args.path.indexOf('!=!') + 3)
      : args.path;
    const parts = request.replace(/^!+/, '').split('!');
    const resource = parts.pop()!;
    const loaders: LoaderItem[] = parts.map((part) => {
      const [loader, query] = splitQuery(part);
      return {loader, options: query ? query.slice(1) : undefined};
    });
    const importer = importerPath(args);
    const [resourceRequest, resourceQuery] = splitQuery(resource);
    const filePath = await resolveFile(
      applyAlias(resourceRequest) ?? resourceRequest,
      path.dirname(importer),
    );
    if (!filePath) {
      return undefined;
    }
    const customLoaders = loaders.filter((l) => !isAssetLoader(l.loader));
    if (customLoaders.length === 0) {
      return resolveAsset(
        filePath,
        importer,
        getAssetRequestFolder(resourceQuery),
      );
    }
    return toLoaderResult(filePath, resourceQuery, customLoaders);
  }

  function toLoaderResult(
    filePath: string,
    resourceQuery: string,
    loaders: LoaderItem[],
  ): OnResolveResult {
    const chainId = getChainId(loaders);
    const separator = resourceQuery ? '&' : '?';
    return {
      path: `${filePath}${resourceQuery}${separator}${ChainParam}=${chainId}`,
      namespace: LoaderNamespace,
    };
  }

  function ruleTests(ruleList: CompatRule[]): RegExp[] {
    return ruleList.flatMap((rule) => [
      ...(rule.test instanceof RegExp ? [rule.test] : []),
      ...ruleTests(rule.oneOf ?? []),
      ...ruleTests(rule.rules ?? []),
    ]);
  }
  // A test like /\.mdx?$/ must also capture requests with a query string
  const ruleFilters = ruleTests(rules).map(
    (test) =>
      new RegExp(
        test.source.replace(/\$$/, '(?:\\?.*)?$'),
        test.flags.replace(/[gy]/g, ''),
      ),
  );

  const assetFilter =
    /\.(?:ico|jpe?g|png|gif|webp|avif|svg|woff2?|eot|ttf|otf|mp4|avi|mov|mkv|mpg|mpeg|vob|wmv|m4v|webm|ogv|wav|mp3|m4a|aac|oga|flac|pdf|docx?|xlsx?|zip|rar)(?:\?.*)?$/i;

  async function resolveRequest(
    args: OnResolveArgs,
  ): Promise<OnResolveResult | undefined> {
    if (args.path.startsWith('!') || args.path.includes('!=!')) {
      return resolveInlineLoaders(args);
    }
    const importer = importerPath(args);
    const [request, resourceQuery] = splitQuery(args.path);
    if (resourceQuery.includes(TextParam)) {
      const textFilePath = await resolveFile(
        applyAlias(request) ?? request,
        path.dirname(importer),
      );
      // Bun dedupes modules by path, even across namespaces: keep the query
      // so that the same file can be imported as text and as a module
      return textFilePath
        ? {path: `${textFilePath}?${TextParam}`, namespace: TextNamespace}
        : undefined;
    }
    const sitePackage = options.sitePackages.find(
      (name) => request === name || request.startsWith(`${name}/`),
    );
    if (sitePackage) {
      try {
        return {path: Bun.resolveSync(request, options.siteDir)};
      } catch {
        return undefined;
      }
    }
    const aliased = applyAlias(request);
    // Bare package requests without anything special for us: Bun resolves
    // them natively, applying the right "exports" conditions for the target
    if (
      aliased === undefined &&
      !isPathRequest(request) &&
      !assetFilter.test(args.path) &&
      !ruleFilters.some((filter) => filter.test(args.path))
    ) {
      return undefined;
    }
    const filePath = await resolveFile(
      aliased ?? request,
      path.dirname(importer),
    );
    if (!filePath) {
      // Let Bun report a proper resolution error
      return undefined;
    }

    let result: OnResolveResult;
    const loaders = resolveRuleLoaders({
      rules,
      resourcePath: filePath,
      resourceQuery,
      issuer: importer,
    });
    if (loaders.length > 0) {
      result = toLoaderResult(filePath, resourceQuery, loaders);
    } else if (isAssetPath(filePath)) {
      result = await resolveAsset(filePath, importer);
    } else {
      result = {path: filePath};
    }

    if (args.kind === 'dynamic-import' && options.onDynamicImport) {
      options.onDynamicImport({
        importer,
        specifier: args.path,
        key: result.namespace
          ? `${result.namespace}:${result.path}`
          : result.path,
      });
    }
    return result;
  }

  // Bun.build only lets us filter on the request: we compute filters that
  // capture everything we need to handle, and let Bun resolve the rest natively
  const aliasRoots = [
    ...new Set([
      ...Object.keys(aliases).map(
        (key) => key.replace(/\$$/, '').split('/')[0]!,
      ),
      ...options.sitePackages,
    ]),
  ];
  const aliasFilter = new RegExp(
    `^(?:${aliasRoots.map(escapeRegExp).join('|')})(?:/|$)`,
  );

  return {
    name: 'docusaurus',
    setup(build) {
      const filters = [
        aliasFilter,
        /^!/,
        /!=!/,
        new RegExp(`[?&]${TextParam}`),
        assetFilter,
        // Absolute paths (registry, CSS root URLs)
        /^\//,
        ...ruleFilters,
      ];
      filters.forEach((filter) => {
        build.onResolve({filter}, resolveRequest);
        build.onResolve({filter, namespace: LoaderNamespace}, resolveRequest);
      });

      build.onLoad({filter: /.*/, namespace: LoaderNamespace}, async (args) => {
        const {resourcePath, resourceQuery, chainId} = parseLoaderPath(
          args.path,
        );
        const loaders = chains[chainId];
        if (!loaders) {
          throw new Error(`Unknown Docusaurus loader chain for ${args.path}`);
        }
        const content = Buffer.from(await Bun.file(resourcePath).bytes());
        // Loaders always run as the "client" compiler: the server bundle reuses
        // the client results. This is what the MDX loader does on its own
        // too, and it lets us share loader results between both bundles.
        const run = async () => {
          const start = performance.now();
          let emittedFiles = false;
          const result = await runLoaders({
            loaders,
            resourcePath,
            resourceQuery,
            content,
            compilerName: 'client',
            mode: options.mode,
            rootContext: options.siteDir,
            onWarning: options.onWarning,
            onEmitFile: (name, fileContent) => {
              emittedFiles = true;
              assetEmitter.emitFile(name, fileContent);
            },
          });
          loaderStats.count += 1;
          loaderStats.time += performance.now() - start;
          return {
            contents:
              typeof result === 'string' ? result : result.toString('utf8'),
            cacheable: !emittedFiles,
          };
        };
        const {loaderCache} = options;
        const contents = loaderCache
          ? await loaderCache.get(
              `${loaders.map((l) => l.loader).join('!')}|${resourcePath}${resourceQuery}`,
              content,
              run,
            )
          : (await run()).contents;
        const isCSS = CSSRegExp.test(resourcePath);
        return {
          contents: isCSS ? contents : rewriteSourceCode(contents),
          loader: isCSS ? 'css' : 'jsx',
        };
      });

      // Text import attributes and new URL() assets in site source files
      // (not in node_modules)
      build.onLoad(
        {filter: /^(?!.*[\\/]node_modules[\\/]).*\.[cm]?[jt]sx?$/},
        async (args) => {
          const code = await Bun.file(args.path).text();
          const contents = rewriteSourceCode(code);
          if (contents === code) {
            return undefined;
          }
          return {contents, loader: getJSLoader(args.path)};
        },
      );

      build.onLoad({filter: /.*/, namespace: TextNamespace}, async (args) => ({
        contents: `export default ${JSON.stringify(
          await Bun.file(splitQuery(args.path)[0]).text(),
        )};`,
        loader: 'js',
      }));

      build.onLoad({filter: /.*/, namespace: AssetNamespace}, async (args) => {
        const [assetPath, query] = splitQuery(args.path);
        const folder = new URLSearchParams(query.slice(1)).get(
          AssetFolderParam,
        ) as AssetFolder | null;
        const asset = await assetEmitter.getAsset(
          assetPath,
          folder ?? undefined,
        );
        // Like Webpack asset modules: require() returns the URL string, and
        // the default import is the URL string too
        return {
          contents: `module.exports = ${JSON.stringify(asset.url)};`,
          loader: 'js',
        };
      });

      if (!isServer && options.postCssPlugins.length > 0) {
        build.onLoad({filter: CSSRegExp}, async (args) => {
          const {default: postcss} = await import('postcss');
          const css = await Bun.file(args.path).text();
          const result = await postcss(
            options.postCssPlugins as AcceptedPlugin[],
          ).process(css, {from: args.path});
          return {contents: result.css, loader: 'css'};
        });
      }

      if (options.contextReplacements.length > 0) {
        build.onLoad(
          {filter: /prism-include-languages\.[jt]sx?$/},
          async (args) => ({
            contents: await expandTemplateRequires(
              await Bun.file(args.path).text(),
              args.path,
              options.contextReplacements,
            ),
            loader: /\.tsx?$/.test(args.path) ? 'tsx' : 'jsx',
          }),
        );
      }
    },
  };
}

/**
 * Emulates Webpack's "require context" for template literal requires such as
 * require(`prismjs/components/prism-${lang}`), restricted to the modules
 * allowed by ContextReplacementPlugin. Bun can't bundle dynamic requires.
 */
async function expandTemplateRequires(
  source: string,
  filePath: string,
  contextReplacements: ContextReplacement[],
): Promise<string> {
  const declarations: string[] = [];
  const replacements = await Promise.all(
    [...source.matchAll(/require\(`([^`$]*)\$\{([^}]+)\}([^`]*)`\)/g)].map(
      async (match, index) => {
        const [fullMatch, prefix = '', expression = '', suffix = ''] = match;
        const slashIndex = prefix.lastIndexOf('/');
        const contextRequest = prefix.slice(0, slashIndex);
        const requestPrefix = prefix.slice(slashIndex + 1);
        // Resolve the package directory, then join the subpath
        const [scopeOrName, ...subpath] = contextRequest.split('/');
        const pkgName = scopeOrName!.startsWith('@')
          ? `${scopeOrName}/${subpath.shift()}`
          : scopeOrName!;
        const pkgDir = path.dirname(
          Bun.resolveSync(`${pkgName}/package.json`, path.dirname(filePath)),
        );
        const contextDir = path.join(pkgDir, ...subpath);
        const replacement = contextReplacements.find((r) =>
          r.resourceRegExp.test(contextDir),
        );
        if (!replacement) {
          return fullMatch;
        }
        const entries = (await fs.readdir(contextDir))
          .filter((file) => file.endsWith('.js'))
          .map((file) => `./${file.replace(/\.js$/, '')}`)
          .filter((request) => replacement.newContentRegExp.test(request));
        const name = `__docusaurusContext${index}`;
        declarations.push(
          `const ${name} = {${entries
            .map(
              (request) =>
                `${JSON.stringify(request)}: () => require(${JSON.stringify(
                  `${contextRequest}/${request.slice(2)}`,
                )})`,
            )
            .join(', ')}};`,
        );
        return `(${name}[${JSON.stringify(`./${requestPrefix}`)} + (${expression}) + ${JSON.stringify(suffix)}] ?? (() => { throw new Error("Cannot find module " + ${JSON.stringify(prefix)} + (${expression})); }))()`;
      },
    ),
  );
  let index = 0;
  const code = source.replace(
    /require\(`([^`$]*)\$\{([^}]+)\}([^`]*)`\)/g,
    () => replacements[index++]!,
  );
  return `${declarations.join('\n')}\n${code}`;
}

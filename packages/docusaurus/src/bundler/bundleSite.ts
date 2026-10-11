/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import logger, {PerfLogger} from '@docusaurus/logger';
import {
  AssetEmitter,
  bunBuild,
  createDocusaurusBunPlugin,
  loaderStats,
  transformFinalCss,
  type DocusaurusBunPluginOptions,
  type LoaderCache,
} from '@docusaurus/bundler';
import {fs, pathExists, readJSON} from '@docusaurus/fs';
import {createSiteLoaderCache} from './loaderCache';
import {loadDocusaurusAliases, loadThemeAliases} from './aliases';
import {loadBundlerContributions} from './contributions';
import {createClientManifest, type ClientManifest} from './manifest';
import type {BuildConfig, BuildOutput} from 'bun';
import type {Props, RouterType} from '@docusaurus/types';

const clientDir = path.join(__dirname, '..', 'client');
export const ClientEntryPath = path.join(clientDir, 'clientEntry.js');
const ServerEntryPath = path.join(clientDir, 'serverEntry.js');

const JSNaming = 'assets/js/[name].[hash].[ext]';
// Bun names shared chunks after the entry point: a fixed entry name keeps the
// entry files (main.<hash>.js/css) distinguishable from shared chunks
const JSEntryNaming = 'assets/js/main.[hash].[ext]';

async function getStaticDirectories(props: Props): Promise<string[]> {
  const {siteDir, siteConfig} = props;
  // Non-existing or empty static dirs are silently ignored
  const dirs = await Promise.all(
    siteConfig.staticDirectories.map(async (dir) => {
      const staticDir = path.resolve(siteDir, dir);
      return (await pathExists(staticDir)) &&
        (await fs.readdir(staticDir)).length > 0
        ? staticDir
        : null;
    }),
  );
  return dirs.filter((dir): dir is string => dir !== null);
}

async function copyStaticDirectories({
  staticDirectories,
  outDir,
}: {
  staticDirectories: string[];
  outDir: string;
}): Promise<void> {
  // The first static dir has priority: copy it last
  for (const dir of [...staticDirectories].reverse()) {
    await fs.cp(dir, outDir, {recursive: true, force: true});
  }
}

export type BundleSiteResult = {
  clientManifestPath: string;
  serverBundlePath: string;
};

export type BundlerSetup = {
  mode: 'production' | 'development';
  publicPath: string;
  staticDirectories: string[];
  createConfig: (params: {
    isServer: boolean;
    outDir: string;
    minify: boolean;
    assetEmitter: AssetEmitter;
    loaderCache?: LoaderCache;
    onDynamicImport?: DocusaurusBunPluginOptions['onDynamicImport'];
  }) => BuildConfig;
};

/**
 * Computes everything needed to create Bun.build() configs for a site.
 * Shared by "docusaurus build" and "docusaurus start".
 */
export async function createBundlerSetup({
  props,
  router,
  dev = false,
}: {
  props: Props;
  router: RouterType;
  /** The dev server only renders the app client-side */
  dev?: boolean;
}): Promise<BundlerSetup> {
  const {siteDir, generatedFilesDir, plugins, baseUrl} = props;
  const isProd = process.env.NODE_ENV === 'production';
  const mode = isProd ? 'production' : 'development';

  // With the hash router, we don't hydrate the React app, even in build mode!
  // This is because it will always be a client-rendered React app
  const hydrate = !dev && router !== 'hash';
  // With the hash router, assets are referenced relatively to the HTML file
  const publicPath = router === 'hash' ? './' : baseUrl;

  const [themeAliases, docusaurusAliases, staticDirectories] =
    await Promise.all([
      loadThemeAliases({siteDir, plugins}),
      loadDocusaurusAliases(),
      getStaticDirectories(props),
    ]);
  const coreAliases = {
    '@site': siteDir,
    '@generated': generatedFilesDir,
    ...docusaurusAliases,
    ...themeAliases,
  };
  const rootDirs = [...staticDirectories, siteDir, process.cwd()];

  const createConfig: BundlerSetup['createConfig'] = ({
    isServer,
    outDir,
    minify,
    assetEmitter,
    loaderCache,
    onDynamicImport,
  }) => {
    const contributions = loadBundlerContributions({
      plugins,
      isServer,
      publicPath,
    });
    const plugin = createDocusaurusBunPlugin({
      isServer,
      mode,
      siteDir,
      rootDirs,
      aliases: {...coreAliases, ...contributions.aliases},
      // Ensure a single copy of React, resolved from the site (escape hatch)
      sitePackages: process.env.DOCUSAURUS_NO_REACT_ALIASES
        ? []
        : ['react', 'react-dom', '@mdx-js/react'],
      rules: contributions.rules,
      contextReplacements: contributions.contextReplacements,
      postCssPlugins: contributions.postCssPlugins,
      assetEmitter,
      loaderCache,
      onDynamicImport,
      onWarning: (warning) => logger.warn(warning),
    });
    const define = {
      'process.env.NODE_ENV': JSON.stringify(mode),
      'process.env.HYDRATE_CLIENT_ENTRY': JSON.stringify(hydrate),
      // Used by some Webpack loaders (ideal-image responsive-loader...)
      __webpack_public_path__: JSON.stringify(publicPath),
      ...contributions.define,
    };
    const common: BuildConfig = {
      entrypoints: [],
      plugins: [plugin],
      define,
      // Never inline the build environment variables in the bundles
      env: 'disable',
      packages: 'bundle',
      jsx: {
        runtime: 'automatic',
        importSource: 'react',
        development: !isProd,
      },
      metafile: true,
      throw: false,
    };
    if (isServer) {
      return {
        ...common,
        entrypoints: [ServerEntryPath],
        outdir: path.join(outDir, '__server'),
        target: 'bun',
        format: 'esm',
        splitting: false,
        minify: false,
        publicPath,
        naming: {entry: 'server.bundle.[ext]'},
      };
    }
    return {
      ...common,
      entrypoints: [ClientEntryPath],
      outdir: outDir,
      target: 'browser',
      format: 'esm',
      splitting: true,
      minify: minify && isProd,
      sourcemap: isProd ? 'none' : 'linked',
      // Without publicPath, chunks import each other with relative URLs,
      // which is what the hash router needs (URLs relative to the document
      // would be resolved against the importing chunk URL)
      publicPath: router === 'hash' ? undefined : publicPath,
      naming: {
        entry: JSEntryNaming,
        chunk: JSNaming,
        asset: 'assets/files/[name]-[hash].[ext]',
      },
    };
  };

  return {mode, publicPath, staticDirectories, createConfig};
}

/**
 * Bundles the client app (browser, code-split ES modules) and the server app
 * (single ES module used for static site generation) with Bun.build()
 */
export async function bundleSite({
  props,
  minify,
  router,
}: {
  props: Props;
  minify: boolean;
  router: RouterType;
}): Promise<BundleSiteResult> {
  const {outDir, generatedFilesDir} = props;
  const setup = await createBundlerSetup({props, router});
  const {publicPath, staticDirectories} = setup;
  const isProd = setup.mode === 'production';

  const assetEmitter = new AssetEmitter({outDir, publicPath});
  const registryPath = path.join(generatedFilesDir, 'registry.js');
  const dynamicImports = new Map<string, string>();
  // Client and server bundles compile the same MDX files: compile them once
  // Results are also persisted on disk for the next builds
  const loaderCache = await createSiteLoaderCache(props);

  const createConfig = (isServer: boolean) =>
    setup.createConfig({
      isServer,
      outDir,
      minify,
      assetEmitter,
      loaderCache,
      onDynamicImport: isServer
        ? undefined
        : ({importer, specifier, key}) => {
            if (importer === registryPath) {
              dynamicImports.set(specifier, key);
            }
          },
    });

  const [clientOutput] = await Promise.all([
    PerfLogger.async('Bundle client', () =>
      bunBuild('Client', createConfig(false)),
    ),
    router === 'hash'
      ? undefined
      : PerfLogger.async('Bundle server', () =>
          bunBuild('Server', createConfig(true)),
        ),
    PerfLogger.async('Copy static directories', () =>
      copyStaticDirectories({staticDirectories, outDir}),
    ),
  ]);

  PerfLogger.log(
    `Loaders: ${loaderStats.count} runs, ${Math.round(loaderStats.time)}ms cumulated`,
  );

  const clientManifestPath = path.join(
    generatedFilesDir,
    'client-manifest.json',
  );
  await PerfLogger.async('Process client output', () =>
    processClientOutput({
      clientOutput,
      outDir,
      publicPath,
      minify: minify && isProd,
      assetEmitter,
      dynamicImports,
      registryJsonPath: path.join(generatedFilesDir, 'registry.json'),
      clientManifestPath,
    }),
  );

  return {
    clientManifestPath,
    serverBundlePath: path.join(outDir, '__server', 'server.bundle.js'),
  };
}

async function processClientOutput({
  clientOutput,
  outDir,
  publicPath,
  minify,
  assetEmitter,
  dynamicImports,
  registryJsonPath,
  clientManifestPath,
}: {
  clientOutput: BuildOutput;
  outDir: string;
  publicPath: string;
  minify: boolean;
  assetEmitter: AssetEmitter;
  dynamicImports: Map<string, string>;
  registryJsonPath: string;
  clientManifestPath: string;
}): Promise<void> {
  const registry = (await readJSON(registryJsonPath)) as {
    [chunkName: string]: string;
  };
  const {manifest, chunkMap} = createClientManifest({
    metafile: clientOutput.metafile!,
    clientEntryPath: ClientEntryPath,
    dynamicImports,
    registry,
  });

  // Docusaurus emits a single CSS file to avoid non-deterministic CSS order
  // The entry CSS bundle already contains the CSS of all lazy chunks
  const entryCss = new Set(manifest.entry.css);
  const cssOutputs = clientOutput.outputs.filter((o) =>
    o.path.endsWith('.css'),
  );
  await Promise.all(
    cssOutputs.map(async (output) => {
      const relativePath = path.relative(outDir, output.path);
      if (!entryCss.has(relativePath)) {
        await fs.rm(output.path, {force: true});
        return;
      }
      const code = transformFinalCss({
        code: await Bun.file(output.path).bytes(),
        filename: relativePath,
        minify,
      });
      await Bun.write(output.path, code);
    }),
  );

  // Prefetching data, fetched lazily by the client
  const chunkMapContent = JSON.stringify({
    files: chunkMap.files.map((file) => `${publicPath}${file}`),
    chunks: chunkMap.chunks,
  });
  const chunkMapHash = Bun.hash(chunkMapContent).toString(16).slice(0, 8);
  const chunkMapFile = `assets/js/chunk-map.${chunkMapHash}.json`;

  const manifestWithChunkMap: ClientManifest = {
    ...manifest,
    chunkMapUrl: `${publicPath}${chunkMapFile}`,
  };

  await Promise.all([
    assetEmitter.writeAll(),
    Bun.write(path.join(outDir, chunkMapFile), chunkMapContent),
    Bun.write(clientManifestPath, JSON.stringify(manifestWithChunkMap)),
  ]);
}

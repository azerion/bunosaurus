/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import _ from 'lodash';
import escapeHTML from 'escape-html';
import logger, {PerfLogger} from '@docusaurus/logger';
import {AssetEmitter, bunBuild, type LoaderCache} from '@docusaurus/bundler';
import {getLocaleConfig} from '@docusaurus/utils';
import {fs, pathExists} from '@docusaurus/fs';
import {watch, type Watcher} from '@docusaurus/glob';
import {ClientEntryPath, createBundlerSetup} from './bundleSite';
import {createSiteLoaderCache} from './loaderCache';
import {
  computeHotUpdate,
  writeDevBuildOutput,
  type DevBuildSnapshot,
} from './hotUpdate';
import type {Server, ServerWebSocket} from 'bun';
import type {Props} from '@docusaurus/types';

const WebSocketPath = '/__docusaurus/dev-server';

// Applies the updates sent by the dev server after rebuilding the app:
// hot updates of route modules and CSS, or page reloads
const createDevClientScript = ({hotOnly}: {hotOnly: boolean}) => `(() => {
  const reload = (reason) => {
    if (${JSON.stringify(hotOnly)}) {
      console.warn('[Docusaurus] The page must be reloaded to apply changes (--hot-only): ' + reason);
      return;
    }
    location.reload();
  };
  const updateCss = (href) => {
    const links = [...document.querySelectorAll('link[data-docusaurus-dev-css]')];
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href + '?t=' + Date.now();
    link.setAttribute('data-docusaurus-dev-css', 'true');
    // Remove the previous stylesheet once the new one applies, avoids a flash
    link.onload = () => links.forEach((previous) => previous.remove());
    document.head.append(link);
  };
  const applyUpdate = async (message) => {
    const hot = window.__DOCUSAURUS_HOT__;
    if (!hot) {
      reload('hot updates are not available');
      return;
    }
    try {
      await hot.apply({modules: message.modules});
      if (message.css) {
        updateCss(message.css);
      }
      console.info('[Docusaurus] Hot update applied');
    } catch (error) {
      console.error('[Docusaurus] Hot update failed', error);
      reload('hot update failed');
    }
  };
  const connect = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(protocol + '//' + location.host + ${JSON.stringify(
      WebSocketPath,
    )});
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'reload') {
        reload(message.reason);
      } else if (message.type === 'hot') {
        void applyUpdate(message);
      } else if (message.type === 'error') {
        console.error('[Docusaurus] Build failed:\\n' + message.message);
      }
    };
    ws.onclose = () => setTimeout(connect, 1000);
  };
  connect();
})();`;

type DevAssets = {scripts: string[]; stylesheets: string[]};

function renderDevHtml({
  props,
  assets,
  hotOnly,
}: {
  props: Props;
  assets: DevAssets;
  hotOnly: boolean;
}): string {
  const {siteConfig, headTags, preBodyTags, postBodyTags} = props;
  const lang = getLocaleConfig(props.i18n).htmlLang;
  return `<!DOCTYPE html>
<html lang="${escapeHTML(lang)}">
  <head>
    <meta charset="utf-8">
    <meta name="generator" content="Docusaurus">
    <title>${escapeHTML(siteConfig.title)}</title>
    ${headTags}
    ${assets.stylesheets.map((href) => `<link href="${escapeHTML(href)}" rel="stylesheet" data-docusaurus-dev-css="true">`).join('')}
    ${assets.scripts.map((src) => `<script type="module" src="${escapeHTML(src)}"></script>`).join('')}
    <script>${createDevClientScript({hotOnly})}</script>
  </head>
  <body>
    ${preBodyTags}
    <div id="__docusaurus"></div>
    ${postBodyTags}
  </body>
</html>
`;
}

// Resolves a request path inside a dir, refusing paths escaping it
function resolveInside(dir: string, relativePath: string): string | null {
  const filePath = path.join(dir, relativePath);
  return filePath === dir || filePath.startsWith(dir + path.sep)
    ? filePath
    : null;
}

async function findFile(
  dirs: string[],
  relativePath: string,
): Promise<string | null> {
  for (const dir of dirs) {
    const filePath = resolveInside(dir, relativePath);
    if (!filePath) {
      continue;
    }
    const candidates =
      relativePath === '' || relativePath.endsWith('/')
        ? [path.join(filePath, 'index.html')]
        : [filePath];
    for (const candidate of candidates) {
      try {
        if ((await fs.stat(candidate)).isFile()) {
          return candidate;
        }
      } catch {
        // Not found
      }
    }
  }
  return null;
}

export type BunDevServer = {
  start: () => Promise<void>;
  stop: () => void;
};

/**
 * The "docusaurus start" dev server: the app is bundled with Bun.build(),
 * rebuilt on file changes, and the browser applies a hot update or reloads
 * after each rebuild.
 */
export async function createBunDevServer({
  getProps,
  host,
  port,
  poll,
  tls,
  hotOnly = false,
}: {
  getProps: () => Props;
  host: string;
  port: number;
  poll?: boolean | number;
  /** Don't reload the page when a change can't be hot-updated */
  hotOnly?: boolean;
  tls?: {cert: Buffer; key: Buffer};
}): Promise<BunDevServer> {
  const initialProps = getProps();
  const {siteDir} = initialProps;
  // Outside of watched dirs (node_modules is ignored)
  const devOutDir = path.join(
    siteDir,
    'node_modules',
    '.cache',
    'docusaurus',
    'dev-server',
    initialProps.i18n.currentLocale,
  );

  // MDX compilation results are reused across rebuilds (and dev sessions)
  // The cache is re-created when the site key changes (config, routes...)
  let loaderCache: LoaderCache | undefined;
  let loaderCacheProps: Props | undefined;
  const sockets = new Set<ServerWebSocket<unknown>>();

  let assets: DevAssets = {scripts: [], stylesheets: []};
  let snapshot: DevBuildSnapshot | undefined;
  // Output path -> content hash, only changed files are written
  const writtenFiles = new Map<string, string>();
  let staticDirectories: string[] = [];
  let externalWatcher: {dirs: string; watcher: Watcher} | undefined;

  function broadcast(message: object) {
    const data = JSON.stringify(message);
    sockets.forEach((socket) => socket.send(data));
  }

  // Returns the message to send to browsers, undefined on build failure
  async function build(): Promise<object | undefined> {
    const props = getProps();
    try {
      const setup = await createBundlerSetup({
        props,
        router: props.siteConfig.future.experimental_router,
        dev: true,
      });
      staticDirectories = setup.staticDirectories;
      if (!loaderCache || loaderCacheProps !== props) {
        loaderCache = await createSiteLoaderCache(props);
        loaderCacheProps = props;
      }
      // Files of previous builds are kept: browsers may still load them
      if (!snapshot) {
        await fs.rm(devOutDir, {recursive: true, force: true});
      }
      const assetEmitter = new AssetEmitter({
        outDir: devOutDir,
        publicPath: setup.publicPath,
      });
      const registryPath = path.join(props.generatedFilesDir, 'registry.js');
      const dynamicImports = new Map<string, string>();
      const config = setup.createConfig({
        isServer: false,
        outDir: devOutDir,
        minify: false,
        assetEmitter,
        loaderCache,
        onDynamicImport: ({importer, specifier, key}) => {
          if (importer === registryPath) {
            dynamicImports.set(specifier, key);
          }
        },
      });
      // Built in memory: we rename chunks before writing them
      delete config.outdir;
      const output = await bunBuild('Client', config);
      await assetEmitter.writeAll();

      if (!snapshot) {
        writtenFiles.clear();
      }
      const nextSnapshot = await writeDevBuildOutput({
        output,
        outDir: devOutDir,
        clientEntryPath: ClientEntryPath,
        dynamicImports,
        writtenFiles,
      });
      const toUrl = (file: string) => `${setup.publicPath}${file}`;
      assets = {
        scripts: [toUrl(nextSnapshot.entryPath)],
        stylesheets: nextSnapshot.cssPath ? [toUrl(nextSnapshot.cssPath)] : [],
      };
      await watchExternalInputs(Object.keys(output.metafile!.inputs));

      const isFirstBuild = !snapshot;
      const update = computeHotUpdate(snapshot, nextSnapshot);
      snapshot = nextSnapshot;
      if (update.type === 'reload') {
        if (!isFirstBuild) {
          if (hotOnly) {
            logger.warn`Reload the browser page to apply changes (${update.reason}), not reloaded automatically because of the code=${'--hot-only'} option`;
          } else {
            logger.info`Reloading the browser page: ${update.reason}`;
          }
        }
        return {type: 'reload', reason: update.reason};
      }
      if (update.type === 'none') {
        return {type: 'none'};
      }
      const moduleCount = Object.keys(update.modules).length;
      logger.info`Hot update: number=${moduleCount} route module(s)${update.cssChanged ? ' and CSS' : ''}`;
      return {
        type: 'hot',
        modules: _.mapValues(update.modules, toUrl),
        css: update.cssChanged ? assets.stylesheets[0] : undefined,
      };
    } catch (error) {
      logger.error(error);
      broadcast({type: 'error', message: String((error as Error).message)});
      return undefined;
    }
  }

  // Serialize rebuilds: a change during a build schedules another build
  let currentBuild: Promise<unknown> = Promise.resolve();
  let pendingBuild = false;
  function scheduleBuild() {
    if (pendingBuild) {
      return;
    }
    pendingBuild = true;
    currentBuild = currentBuild.then(async () => {
      pendingBuild = false;
      const message = await PerfLogger.async('Rebuild client', build);
      if (message) {
        broadcast(message);
      }
    });
  }
  const onFileChange = _.debounce(scheduleBuild, 100);

  const ignoredRegExp = /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/;
  function isIgnored(filePath: string) {
    const props = getProps();
    return (
      ignoredRegExp.test(filePath) ||
      filePath.startsWith(props.outDir) ||
      filePath.endsWith('client-manifest.json')
    );
  }

  const pollingOptions = {
    usePolling: !!poll,
    interval: typeof poll === 'number' ? poll : undefined,
  };

  // The site dir is watched recursively: content, theme, generated files...
  // Files outside the site dir (monorepo packages...) are watched by dir
  async function watchExternalInputs(inputs: string[]) {
    const candidateDirs = [
      ...new Set(
        inputs
          .map((input) => input.replace(/^[\w-]{2,}:/, '').split('?')[0]!)
          .map((input) => path.dirname(path.resolve(input)))
          .filter(
            (dir) => !dir.startsWith(siteDir) && !ignoredRegExp.test(dir),
          ),
      ),
    ];
    const dirs = (
      await Promise.all(
        candidateDirs.map(async (dir) =>
          (await pathExists(dir)) ? dir : null,
        ),
      )
    )
      .filter((dir): dir is string => dir !== null)
      .sort();
    const dirsKey = dirs.join('\n');
    if (externalWatcher?.dirs === dirsKey) {
      return;
    }
    await externalWatcher?.watcher.close();
    externalWatcher = undefined;
    if (dirs.length > 0) {
      const watcher = watch(dirs, {...pollingOptions, depth: 0} as Parameters<
        typeof watch
      >[1]);
      watcher.on('all', () => onFileChange());
      externalWatcher = {dirs: dirsKey, watcher};
    }
  }

  let siteWatcher: Watcher | undefined;
  let server: Server<unknown> | undefined;

  return {
    start: async () => {
      const firstBuildSuccess = !!(await PerfLogger.async(
        'Bundle client',
        build,
      ));

      // E2E_TEST=true docusaurus start
      // Makes "docusaurus start" exit immediately on success/error
      if (process.env.E2E_TEST) {
        if (firstBuildSuccess) {
          logger.success('E2E_TEST: Project can compile.');
          process.exit(0);
        }
        logger.error('E2E_TEST: Project has compiler errors.');
        process.exit(1);
      }

      siteWatcher = watch(siteDir, {
        ...pollingOptions,
        ignored: (filePath: string) => isIgnored(filePath),
      } as Parameters<typeof watch>[1]);
      siteWatcher.on('all', () => onFileChange());

      server = Bun.serve({
        hostname: host,
        port,
        tls,
        development: false,
        websocket: {
          open: (ws) => {
            sockets.add(ws);
          },
          close: (ws) => {
            sockets.delete(ws);
          },
          message: () => {},
        },
        fetch: async (req, srv) => {
          const url = new URL(req.url);
          if (url.pathname === WebSocketPath) {
            return srv.upgrade(req, {data: undefined})
              ? undefined
              : new Response('WebSocket upgrade failed', {status: 400});
          }
          const props = getProps();
          const {baseUrl} = props;
          let pathname: string;
          try {
            pathname = decodeURIComponent(url.pathname);
          } catch {
            return new Response('Bad request', {status: 400});
          }
          if (!pathname.startsWith(baseUrl)) {
            if (`${pathname}/` === baseUrl || pathname === '/') {
              return Response.redirect(baseUrl, 302);
            }
            return new Response(`Not found. The site is served at ${baseUrl}`, {
              status: 404,
            });
          }
          // Wait for the current build, avoid serving stale/missing assets
          await currentBuild;
          const relativePath = pathname.slice(baseUrl.length);
          const file = await findFile(
            [devOutDir, ...staticDirectories],
            relativePath,
          );
          if (file) {
            return new Response(Bun.file(file), {
              headers: {
                'access-control-allow-origin': '*',
                // The entry URL doesn't change across rebuilds
                'cache-control': 'no-cache',
              },
            });
          }
          // Missing assets are not app routes
          const ext = path.extname(relativePath);
          if (ext && ext !== '.html') {
            return new Response('Not found', {status: 404});
          }
          // Client-side routing: every other path renders the app
          return new Response(renderDevHtml({props, assets, hotOnly}), {
            headers: {'content-type': 'text/html; charset=utf-8'},
          });
        },
      });
    },
    stop: () => {
      void siteWatcher?.close();
      void externalWatcher?.watcher.close();
      server?.stop(true);
    },
  };
}

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
import type {Server, ServerWebSocket} from 'bun';
import type {Props} from '@docusaurus/types';

const WebSocketPath = '/__docusaurus/dev-server';

// Reloads the page when the dev server rebuilds the app
const LiveReloadClientScript = `(() => {
  const connect = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(protocol + '//' + location.host + ${JSON.stringify(
      WebSocketPath,
    )});
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'reload') {
        location.reload();
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
}: {
  props: Props;
  assets: DevAssets;
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
    ${assets.stylesheets.map((href) => `<link href="${escapeHTML(href)}" rel="stylesheet">`).join('')}
    ${assets.scripts.map((src) => `<script type="module" src="${escapeHTML(src)}"></script>`).join('')}
    <script>${LiveReloadClientScript}</script>
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
 * rebuilt on file changes, and the browser reloads after each rebuild.
 */
export async function createBunDevServer({
  getProps,
  host,
  port,
  poll,
  tls,
}: {
  getProps: () => Props;
  host: string;
  port: number;
  poll?: boolean | number;
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
  let staticDirectories: string[] = [];
  let externalWatcher: {dirs: string; watcher: Watcher} | undefined;

  function broadcast(message: object) {
    const data = JSON.stringify(message);
    sockets.forEach((socket) => socket.send(data));
  }

  async function build(): Promise<boolean> {
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
      await fs.rm(devOutDir, {recursive: true, force: true});
      const assetEmitter = new AssetEmitter({
        outDir: devOutDir,
        publicPath: setup.publicPath,
      });
      const output = await bunBuild(
        'Client',
        setup.createConfig({
          isServer: false,
          outDir: devOutDir,
          minify: false,
          assetEmitter,
          loaderCache,
        }),
      );
      await assetEmitter.writeAll();

      const metafile = output.metafile!;
      const entry = Object.entries(metafile.outputs).find(
        ([outputPath, o]) =>
          outputPath.endsWith('.js') &&
          o.entryPoint &&
          path.resolve(o.entryPoint) === ClientEntryPath,
      );
      if (!entry) {
        throw new Error('Docusaurus Bug: client entry output not found');
      }
      const toUrl = (file: string) =>
        `${setup.publicPath}${file.replace(/^\.\//, '')}`;
      assets = {
        scripts: [toUrl(entry[0])],
        stylesheets: entry[1].cssBundle ? [toUrl(entry[1].cssBundle)] : [],
      };
      await watchExternalInputs(Object.keys(metafile.inputs));
      return true;
    } catch (error) {
      logger.error(error);
      broadcast({type: 'error', message: String((error as Error).message)});
      return false;
    }
  }

  // Serialize rebuilds: a change during a build schedules another build
  let currentBuild: Promise<boolean> = Promise.resolve(true);
  let pendingBuild = false;
  function scheduleBuild() {
    if (pendingBuild) {
      return;
    }
    pendingBuild = true;
    currentBuild = currentBuild.then(async () => {
      pendingBuild = false;
      const success = await PerfLogger.async('Rebuild client', build);
      if (success) {
        broadcast({type: 'reload'});
      }
      return success;
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
      const firstBuildSuccess = await PerfLogger.async('Bundle client', build);

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
              headers: {'access-control-allow-origin': '*'},
            });
          }
          // Missing assets are not app routes
          const ext = path.extname(relativePath);
          if (ext && ext !== '.html') {
            return new Response('Not found', {status: 404});
          }
          // Client-side routing: every other path renders the app
          return new Response(renderDevHtml({props, assets}), {
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

/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import logger, {PerfLogger} from '@docusaurus/logger';
import openBrowser from '../utils/openBrowser/openBrowser';
import {setupSiteFileWatchers} from './watcher';
import {createBunDevServer} from '../../bundler/devServer';
import getHttpsConfig from './getHttpsConfig';
import {createReloadableSite} from './utils';
import type {LoadContextParams} from '../../server/site';
import type {HostPortOptions} from '../../server/getHostPort';

export type StartCLIOptions = HostPortOptions &
  Pick<LoadContextParams, 'locale' | 'config'> & {
    hotOnly?: boolean;
    open?: boolean;
    poll?: boolean | number;
    minify?: boolean;
    https?: true;
    sslCert?: string;
    sslKey?: string;
  };

async function doStart(
  siteDirParam: string = '.',
  cliOptions: Partial<StartCLIOptions> = {},
): Promise<void> {
  logger.info('Starting the development server...');
  // Temporary workaround to unlock the ability to translate the site config
  // We'll remove it if a better official API can be designed
  // See https://github.com/facebook/docusaurus/issues/4542
  process.env.DOCUSAURUS_CURRENT_LOCALE = cliOptions.locale;

  const reloadableSite = await createReloadableSite({siteDirParam, cliOptions});

  setupSiteFileWatchers(
    {props: reloadableSite.get().props, cliOptions},
    ({plugin}) => {
      if (plugin) {
        reloadableSite.reloadPlugin(plugin);
      } else {
        reloadableSite.reload();
      }
    },
  );

  const httpsConfig = await getHttpsConfig({
    https: cliOptions.https,
    sslCert: cliOptions.sslCert,
    sslKey: cliOptions.sslKey,
  });
  if (httpsConfig === true) {
    logger.warn`The Docusaurus dev server requires a certificate and key to serve over HTTPS (--ssl-cert and --ssl-key), the site is served over HTTP.`;
  }

  const devServer = await createBunDevServer({
    getProps: () => reloadableSite.get().props,
    host: reloadableSite.openUrlContext.host,
    port: reloadableSite.openUrlContext.port,
    poll: cliOptions.poll,
    hotOnly: cliOptions.hotOnly,
    tls: typeof httpsConfig === 'object' ? httpsConfig : undefined,
  });

  ['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => {
      devServer.stop();
      process.exit();
    });
  });

  await devServer.start();
  if (cliOptions.open) {
    await openBrowser(reloadableSite.getOpenUrl());
  }
}

export async function start(
  siteDirParam: string = '.',
  cliOptions: Partial<StartCLIOptions> = {},
): Promise<void> {
  return PerfLogger.async('CLI start', () => doStart(siteDirParam, cliOptions));
}

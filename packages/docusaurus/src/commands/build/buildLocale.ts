/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import _ from 'lodash';
import logger, {PerfLogger} from '@docusaurus/logger';
import {fs} from '@docusaurus/fs';
import {loadSite} from '../../server/site';
import {handleBrokenLinks} from '../../server/brokenLinks';
import {bundleSite} from '../../bundler/bundleSite';
import {executeSSG} from '../../ssg/ssgExecutor';
import clearPath from '../utils/clearPath';
import {isAutomaticBaseUrlLocalizationDisabled} from './buildUtils';
import type {BuildCLIOptions} from './build';
import type {SiteCollectedData} from '../../common';
import type {LoadedPlugin, Props} from '@docusaurus/types';

export type BuildLocaleParams = {
  siteDir: string;
  locale: string;
  cliOptions: Partial<BuildCLIOptions>;
};

const SkipBundling = process.env.DOCUSAURUS_SKIP_BUNDLING === 'true';
const ReturnAfterLoading = process.env.DOCUSAURUS_RETURN_AFTER_LOADING === 'true';
const ExitAfterLoading = process.env.DOCUSAURUS_EXIT_AFTER_LOADING === 'true';
const ExitAfterBundling = process.env.DOCUSAURUS_EXIT_AFTER_BUNDLING === 'true';

/**
 * Loads and bundles a localized site, and returns a function to finish the
 * build (SSG, postBuild, broken links...).
 * Splitting the build in 2 steps allows the next locale to be loaded and
 * bundled while the current locale is finishing its build.
 */
export async function bundleLocale({
  siteDir,
  locale,
  cliOptions,
}: BuildLocaleParams): Promise<() => Promise<void>> {
  const noop = async () => {};
  // Temporary workaround to unlock the ability to translate the site config
  // We'll remove it if a better official API can be designed
  // See https://github.com/facebook/docusaurus/issues/4542
  process.env.DOCUSAURUS_CURRENT_LOCALE = locale;

  logger.info`name=${`[${locale}]`} Creating an optimized production build...`;

  const site = await PerfLogger.async('Load site', () =>
    loadSite({
      siteDir,
      outDir: cliOptions.outDir,
      config: cliOptions.config,
      locale,
      automaticBaseUrlLocalizationDisabled: isAutomaticBaseUrlLocalizationDisabled(cliOptions),
    }),
  );

  if (ReturnAfterLoading) {
    return noop;
  }
  if (ExitAfterLoading) {
    return process.exit(0);
  }

  const {props} = site;
  const {outDir, siteConfig} = props;

  const router = siteConfig.future.experimental_router;

  const generatedFilesDir = props.generatedFilesDir;
  let serverBundlePath = path.join(outDir, '__server', 'server.bundle.js');
  let clientManifestPath = path.join(generatedFilesDir, 'client-manifest.json');

  if (SkipBundling) {
    console.warn(
      `Skipping the Docusaurus bundling step because DOCUSAURUS_SKIP_BUNDLING='true'`,
    );
  } else {
    // We clear the website/build dir before bundling
    await clearPath(outDir);
    ({serverBundlePath, clientManifestPath} = await PerfLogger.async(
      'Bundling with Bun',
      () =>
        bundleSite({
          props,
          minify: cliOptions.minify ?? true,
          router,
        }),
    ));
  }
  if (ExitAfterBundling) {
    return process.exit(0);
  }

  return () =>
    PerfLogger.async(`${locale} > Finish`, () =>
      finishLocale({props, serverBundlePath, clientManifestPath, router}),
    );
}

async function finishLocale({
  props,
  serverBundlePath,
  clientManifestPath,
  router,
}: {
  props: Props;
  serverBundlePath: string;
  clientManifestPath: string;
  router: Props['siteConfig']['future']['experimental_router'];
}): Promise<void> {
  const {outDir, plugins} = props;
  const {collectedData} = await PerfLogger.async('SSG', () =>
    executeSSG({
      props,
      serverBundlePath,
      clientManifestPath,
      router,
    }),
  );

  await cleanupServerBundle(serverBundlePath);

  // Plugin Lifecycle - postBuild.
  await PerfLogger.async('postBuild()', () =>
    executePluginsPostBuild({plugins, props, collectedData}),
  );

  // TODO execute this in parallel to postBuild?
  await PerfLogger.async('Broken links checker', () =>
    executeBrokenLinksCheck({props, collectedData}),
  );

  logger.success`Generated static files in path=${path.relative(
    process.cwd(),
    outDir,
  )}.`;
}

async function executePluginsPostBuild({
  plugins,
  props,
  collectedData,
}: {
  plugins: LoadedPlugin[];
  props: Props;
  collectedData: SiteCollectedData;
}) {
  const routesBuildMetadata = _.mapValues(
    collectedData,
    (d) => d.metadata.public,
  );

  await Promise.all(
    plugins.map(async (plugin) => {
      if (!plugin.postBuild) {
        return;
      }
      await plugin.postBuild({
        ...props,
        routesBuildMetadata,
        content: plugin.content,
      });
    }),
  );
}

async function executeBrokenLinksCheck({
  props: {
    routes,
    siteConfig: {onBrokenLinks, onBrokenAnchors},
  },
  collectedData,
}: {
  props: Props;
  collectedData: SiteCollectedData;
}) {
  const collectedLinks = _.mapValues(collectedData, (d) => ({
    links: d.links,
    anchors: d.anchors,
  }));
  await handleBrokenLinks({
    collectedLinks,
    routes,
    onBrokenLinks,
    onBrokenAnchors,
  });
}

// Remove /build/server server.bundle.js because it is not needed.
async function cleanupServerBundle(serverBundlePath: string) {
  if (process.env.DOCUSAURUS_KEEP_SERVER_BUNDLE === 'true') {
    logger.warn(
      "Will NOT delete server bundle because DOCUSAURUS_KEEP_SERVER_BUNDLE='true'",
    );
  } else {
    await PerfLogger.async('Deleting server bundle', async () => {
      // For now we assume server entry is at the root of the server out dir
      const serverDir = path.dirname(serverBundlePath);
      await fs.rm(serverDir, {recursive: true, force: true});
    });
  }
}

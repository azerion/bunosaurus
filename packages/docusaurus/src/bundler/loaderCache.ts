/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {fs} from '@docusaurus/fs';
import logger from '@docusaurus/logger';
import {LoaderCache} from '@docusaurus/bundler';
import {DOCUSAURUS_VERSION} from '@docusaurus/utils';
import type {Props} from '@docusaurus/types';

/**
 * Everything that can affect the output of loaders, apart from the content of
 * the file being loaded. Any change invalidates the whole persistent cache.
 * Routes are included because MDX links are resolved to other docs permalinks.
 */
function computeGlobalCacheKey(props: Props): string | null {
  try {
    const keyData = JSON.stringify(
      {
        docusaurusVersion: DOCUSAURUS_VERSION,
        bunVersion: Bun.version,
        mode: process.env.NODE_ENV,
        locale: props.i18n.currentLocale,
        siteConfig: props.siteConfig,
        plugins: props.plugins.map((plugin) => ({
          name: plugin.name,
          version: plugin.version,
          options: plugin.options,
        })),
        routesPaths: props.routesPaths,
      },
      // Functions (remark plugins...) are part of the config too
      (_key, value: unknown) =>
        typeof value === 'function' ? value.toString() : value,
    );
    return Bun.hash(keyData).toString(36);
  } catch (error) {
    logger.warn`Docusaurus persistent loader cache disabled: ${String(error)}`;
    return null;
  }
}

/**
 * Creates the loader cache for a site build. Results are persisted in
 * node_modules/.cache, unless DOCUSAURUS_NO_PERSISTENT_CACHE is set.
 */
export async function createSiteLoaderCache(
  props: Props,
): Promise<LoaderCache> {
  if (process.env.DOCUSAURUS_NO_PERSISTENT_CACHE) {
    return new LoaderCache();
  }
  const globalKey = computeGlobalCacheKey(props);
  if (!globalKey) {
    return new LoaderCache();
  }
  const localeDir = path.join(
    props.siteDir,
    'node_modules',
    '.cache',
    'docusaurus',
    'loaders',
    props.i18n.currentLocale,
  );
  const diskDir = path.join(localeDir, globalKey);
  // Only keep the cache of the current key, for each locale
  const existing = await fs.readdir(localeDir).catch(() => [] as string[]);
  await Promise.all(
    existing
      .filter((dir) => dir !== globalKey)
      .map((dir) =>
        fs.rm(path.join(localeDir, dir), {recursive: true, force: true}),
      ),
  );
  await fs.mkdir(diskDir, {recursive: true});
  return new LoaderCache({diskDir});
}

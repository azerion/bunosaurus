/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import logger from '@docusaurus/logger';
import {BundlerInstanceShim} from './bun/webpackCompat';
import type {CurrentBundler, DocusaurusConfig} from '@docusaurus/types';

let warnedAboutWebpackConfig = false;

/**
 * Docusaurus always bundles with Bun. The "bundler instance" exposed to
 * plugins (configureWebpack utils) is a shim of the Webpack plugins that the
 * Bun bundler knows how to interpret (DefinePlugin...).
 */
export async function getCurrentBundler({
  siteConfig,
}: {
  siteConfig: {webpack?: DocusaurusConfig['webpack']};
}): Promise<CurrentBundler> {
  if (siteConfig.webpack && !warnedAboutWebpackConfig) {
    warnedAboutWebpackConfig = true;
    logger.warn`The Docusaurus config code=${'siteConfig.webpack'} is ignored: Docusaurus always uses the Bun bundler.`;
  }
  return {
    name: 'bun',
    instance: BundlerInstanceShim as unknown as CurrentBundler['instance'],
  };
}

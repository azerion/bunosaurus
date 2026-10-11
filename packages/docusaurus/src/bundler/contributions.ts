/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  mergeWithCustomize,
  customizeArray,
  customizeObject,
} from 'webpack-merge';
import {
  BundlerInstanceShim,
  interpretWebpackConfig,
  type BundlerContributions,
} from '@docusaurus/bundler';
import {getFileLoaderUtils} from '@docusaurus/utils';
import type {
  ConfigureWebpackUtils,
  CurrentBundler,
  LoadedPlugin,
  PostCssOptions,
  WebpackConfiguration as Configuration,
} from '@docusaurus/types';

export type DocusaurusBundlerContributions = BundlerContributions & {
  postCssPlugins: unknown[];
};

const configureWebpackUtils: ConfigureWebpackUtils = {
  currentBundler: {
    name: 'bun',
    instance: BundlerInstanceShim,
  } as unknown as CurrentBundler,
  // Style and JS loaders are handled natively by Bun
  getStyleLoaders: () => [],
  getJSLoader: () => ({loader: require.resolve('./noopLoader')}),
};

/**
 * The initial config passed to configureWebpack(), containing the Docusaurus
 * core asset rules: some plugins (SVGR) look them up to enhance them.
 */
function createVirtualConfig({
  isServer,
  publicPath,
}: {
  isServer: boolean;
  publicPath: string;
}): Configuration {
  const {rules} = getFileLoaderUtils(isServer);
  return {
    name: isServer ? 'server' : 'client',
    output: {publicPath},
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    resolve: {alias: {}},
    module: {
      rules: [
        rules.images(),
        rules.svgs(),
        rules.fonts(),
        rules.media(),
        rules.otherAssets(),
      ],
    },
    plugins: [],
  };
}

function executePluginsConfigureWebpack({
  plugins,
  isServer,
  publicPath,
}: {
  plugins: LoadedPlugin[];
  isServer: boolean;
  publicPath: string;
}): Configuration {
  let config = createVirtualConfig({isServer, publicPath});
  plugins.forEach((plugin) => {
    const {configureWebpack} = plugin;
    if (!configureWebpack) {
      return;
    }
    // The plugin lifecycle may reference `this`, and may mutate config
    const {mergeStrategy, ...result} =
      configureWebpack.call(
        plugin,
        config,
        isServer,
        configureWebpackUtils,
        plugin.content,
      ) ?? {};
    const customizeRules = mergeStrategy ?? {};
    config = mergeWithCustomize({
      customizeArray: customizeArray(customizeRules),
      customizeObject: customizeObject(customizeRules),
    })(config, result as Configuration);
  });
  return config;
}

function executePluginsConfigurePostCss({
  plugins,
}: {
  plugins: LoadedPlugin[];
}): unknown[] {
  let options: PostCssOptions = {ident: 'postcss', plugins: []};
  plugins.forEach((plugin) => {
    if (plugin.configurePostCss) {
      options = plugin.configurePostCss.call(plugin, options);
    }
  });
  return options.plugins;
}

/**
 * Collects what plugins contribute to the bundler, through the historical
 * configureWebpack() and configurePostCss() lifecycles
 */
export function loadBundlerContributions({
  plugins,
  isServer,
  publicPath,
}: {
  plugins: LoadedPlugin[];
  isServer: boolean;
  publicPath: string;
}): DocusaurusBundlerContributions {
  const config = executePluginsConfigureWebpack({
    plugins,
    isServer,
    publicPath,
  });
  return {
    ...interpretWebpackConfig(config),
    // PostCSS is only useful for the client CSS output
    postCssPlugins: isServer ? [] : executePluginsConfigurePostCss({plugins}),
  };
}

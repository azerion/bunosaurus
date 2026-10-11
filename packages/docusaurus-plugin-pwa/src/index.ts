/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {bunBuild} from '@docusaurus/bundler';
import {injectManifest} from 'workbox-build';
import {normalizeUrl} from '@docusaurus/utils';
import logger from '@docusaurus/logger';
import {readDefaultCodeTranslationMessages} from '@docusaurus/theme-translations';
import type {HtmlTags, LoadContext, Plugin} from '@docusaurus/types';
import type {PluginOptions} from '@docusaurus/plugin-pwa';

const PluginName = 'docusaurus-plugin-pwa';

export default function pluginPWA(
  context: LoadContext,
  options: PluginOptions,
): Plugin<void> | null {
  if (process.env.NODE_ENV !== 'production') {
    return null;
  }
  if (context.siteConfig.future.experimental_router === 'hash') {
    logger.warn(
      `${PluginName} does not support the Hash Router and will be disabled.`,
    );
    return null;
  }

  const {
    outDir,
    baseUrl,
    i18n: {currentLocale},
  } = context;
  const {
    debug,
    offlineModeActivationStrategies,
    injectManifestConfig,
    pwaHead,
    swCustom,
    swRegister,
  } = options;

  return {
    name: PluginName,

    getThemePath() {
      return '../lib/theme';
    },
    getTypeScriptThemePath() {
      return '../src/theme';
    },

    getClientModules() {
      return swRegister ? [swRegister] : [];
    },

    getDefaultCodeTranslationMessages() {
      return readDefaultCodeTranslationMessages({
        locale: currentLocale,
        name: 'plugin-pwa',
      });
    },

    configureWebpack(config, isServer, {currentBundler}) {
      return {
        plugins: [
          new currentBundler.instance.EnvironmentPlugin({
            PWA_DEBUG: debug,
            PWA_SERVICE_WORKER_URL: path.posix.resolve(
              `${(config.output?.publicPath as string) || '/'}`,
              'sw.js',
            ),
            PWA_OFFLINE_MODE_ACTIVATION_STRATEGIES:
              offlineModeActivationStrategies,
          }),
        ],
      };
    },

    injectHtmlTags() {
      const headTags: HtmlTags = [];
      pwaHead.forEach(({tagName, ...attributes}) => {
        (['href', 'content'] as const).forEach((attribute) => {
          const attributeValue = attributes[attribute];

          if (!attributeValue) {
            return;
          }

          const attributePath =
            !!path.extname(attributeValue) && attributeValue;

          if (attributePath && !attributePath.startsWith(baseUrl)) {
            attributes[attribute] = normalizeUrl([baseUrl, attributeValue]);
          }
        });

        return headTags.push({
          tagName,
          attributes,
        });
      });
      return {headTags};
    },

    async postBuild(props) {
      // The service worker is a classic script, bundled on its own
      await bunBuild('Service Worker', {
        entrypoints: [require.resolve('./sw.js')],
        outdir: outDir,
        naming: 'sw.js',
        target: 'browser',
        format: 'iife',
        minify: !debug,
        sourcemap: debug ? 'linked' : 'none',
        publicPath: baseUrl,
        env: 'disable',
        define: {
          'process.env.NODE_ENV': JSON.stringify(
            debug ? 'development' : 'production',
          ),
          'process.env.PWA_SW_CUSTOM': JSON.stringify(swCustom ?? ''),
        },
      });

      const swDest = path.resolve(props.outDir, 'sw.js');

      await injectManifest({
        ...injectManifestConfig,
        globPatterns: [
          '**/*.{js,json,css,html}',
          '**/*.{png,jpg,jpeg,gif,svg,ico}',
          '**/*.{woff,woff2,eot,ttf,otf}',
          // @ts-expect-error: internal API?
          ...((injectManifest.globPatterns as string[] | undefined) ?? []),
        ],
        // Those attributes are not overrideable
        swDest,
        swSrc: swDest,
        globDirectory: props.outDir,
      });
    },
  };
}

export {validateOptions} from './options';

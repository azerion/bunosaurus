/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import logger, {PerfLogger} from '@docusaurus/logger';
import {mapAsyncSequential} from '@docusaurus/utils';
import {realpath} from '@docusaurus/fs';
import {type LoadContextParams} from '../../server/site';
import {getLocaleList} from '../../server/i18n';
import {bundleLocale, type BuildLocaleParams} from './buildLocale';
import {loadSiteConfig} from '../../server/config';

export type BuildCLIOptions = Pick<LoadContextParams, 'config' | 'outDir'> & {
  locale?: [string, ...string[]];
  minify?: boolean;
  dev?: boolean;
};

export async function build(
  siteDirParam: string = '.',
  cliOptions: Partial<BuildCLIOptions> = {},
): Promise<void> {
  process.env.BABEL_ENV = 'production';
  process.env.NODE_ENV = 'production';
  if (cliOptions.dev) {
    logger.info`Building in dev mode`;
    process.env.BABEL_ENV = 'development';
    process.env.NODE_ENV = 'development';
  }

  const siteDir = await realpath(siteDirParam);

  ['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => process.exit());
  });

  const locales = await PerfLogger.async('Get locales to build', () =>
    getLocalesToBuild({siteDir, cliOptions}),
  );

  if (locales.length > 1) {
    logger.info`Website will be built for all these locales: ${locales}`;
  }

  await PerfLogger.async(`Build`, async () => {
    // Escape hatch to build localized sites fully sequentially
    if (process.env.DOCUSAURUS_BUILD_LOCALES_SEQUENTIALLY === 'true') {
      await mapAsyncSequential(locales, async (locale) => {
        const finish = await tryToBundleLocale({siteDir, locale, cliOptions});
        await finish();
      });
      return;
    }
    // Localized sites are loaded and bundled sequentially (the site config
    // can depend on the current locale env variable), but each locale
    // finishes its build (SSG, postBuild...) while the next one is bundled
    const finishing: Promise<void>[] = [];
    for (const locale of locales) {
      const finish = await tryToBundleLocale({siteDir, locale, cliOptions});
      finishing.push(finish());
    }
    await Promise.all(finishing);
  });

  logger.info`Use code=${'npm run serve'} command to test your build locally.`;
}

// We need the default locale to always be the 1st in the list. If we build it
// last, it would "erase" the localized sites built in sub-folders
function orderLocales({
  locales,
  defaultLocale,
}: {
  locales: [string, ...string[]];
  defaultLocale: string;
}): [string, ...string[]] {
  if (locales.includes(defaultLocale)) {
    return [
      defaultLocale,
      ...locales.filter((locale) => locale !== defaultLocale),
    ];
  } else {
    return locales;
  }
}

async function getLocalesToBuild({
  siteDir,
  cliOptions,
}: {
  siteDir: string;
  cliOptions: BuildCLIOptions;
}): Promise<[string, ...string[]]> {
  const {siteConfig} = await loadSiteConfig({
    siteDir,
    customConfigFilePath: cliOptions.config,
  });

  const locales =
    cliOptions.locale ??
    getLocaleList({
      i18nConfig: siteConfig.i18n,
      currentLocale: siteConfig.i18n.defaultLocale, // Awkward but ok
    });

  return orderLocales({
    locales: locales as [string, ...string[]],
    defaultLocale: siteConfig.i18n.defaultLocale,
  });
}

async function tryToBundleLocale(
  params: BuildLocaleParams,
): Promise<() => Promise<void>> {
  const wrapError = (err: unknown) =>
    new Error(
      logger.interpolate`Unable to build website for locale name=${params.locale}.`,
      {cause: err},
    );
  try {
    const finish = await PerfLogger.async(
      `${logger.name(params.locale)}`,
      () => bundleLocale(params),
    );
    return () =>
      finish().catch((err) => {
        throw wrapError(err);
      });
  } catch (err) {
    throw wrapError(err);
  }
}


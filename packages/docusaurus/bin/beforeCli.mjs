/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// @ts-check

import path from 'node:path';
import {createRequire} from 'node:module';
import {logger} from '@docusaurus/logger';
import semver from 'semver';
import updateNotifier from 'update-notifier';
import boxen from 'boxen';
import {DOCUSAURUS_VERSION} from '@docusaurus/utils';

const packageJson = /** @type {typeof import("../package.json")} */ (
  createRequire(import.meta.url)('../package.json')
);
/** @type {Record<string, any>} */
let sitePkg;
try {
  sitePkg = createRequire(path.resolve('package.json'))('./package.json');
} catch {
  logger.warn`path=${'package.json'} file not found at CWD: path=${process.cwd()}.`;
  logger.info`This is non-critical, but could lead to undesired behavior downstream. Docusaurus assumes that path=${'package.json'} exists at CWD, because it's where the package manager looks up the script at. A common reason is because you have changed directory in the script. Instead of writing code=${'"start": "cd website && docusaurus start"'}, consider using the code=${'[siteDir]'} argument: code=${'"start": "docusaurus start website"'}.`;
  sitePkg = {};
}

const {
  name,
  engines: {bun: requiredVersion},
} = packageJson;

/**
 * Notify user if `@docusaurus` packages are outdated
 *
 * Note: this is a 2-step process to avoid delaying cli usage by awaiting a
 * response:
 * - 1st run: trigger background job to check releases + store result
 * - 2nd run: display potential update to users
 *
 * cache data is stored in `~/.config/configstore/update-notifier-@docusaurus`
 */
export default async function beforeCli() {
  const notifier = updateNotifier({
    pkg: {
      name,
      version: DOCUSAURUS_VERSION,
    },
    // Check is in background so it's fine to use a small value like 1h
    // Use 0 for debugging
    updateCheckInterval: 1000 * 60 * 60,
  });

  // Hacky way to ensure we check for updates on first run
  // Note: the notification will only happen in the 2nd run
  // See https://github.com/yeoman/update-notifier/issues/209
  try {
    // Note: notifier.config is undefined when the notifier is disabled
    const lastUpdateCheck = notifier.config?.get('lastUpdateCheck');
    if (
      notifier.config &&
      typeof lastUpdateCheck === 'number' &&
      Date.now() - lastUpdateCheck < 50
    ) {
      notifier.config.set('lastUpdateCheck', 0);
      notifier.check();
    }
  } catch (err) {
    // Do not stop cli if this fails, see https://github.com/facebook/docusaurus/issues/5400
    logger.error(err);
  }

  /**
   * We don't want to display update message for canary releases.
   * See https://github.com/facebook/docusaurus/issues/5378
   * @param {import('update-notifier').UpdateInfo} update
   */
  function ignoreUpdate(update) {
    const isCanaryRelease = update?.current?.startsWith('0.0.0');
    return isCanaryRelease;
  }

  if (
    notifier.config &&
    notifier.update &&
    semver.lt(notifier.update.current, notifier.update.latest)
  ) {
    // Because notifier clears cached data after reading it, leading to notifier
    // not consistently displaying the update.
    // See https://github.com/yeoman/update-notifier/issues/209
    notifier.config.set('update', notifier.update);

    if (ignoreUpdate(notifier.update)) {
      return;
    }

    // Packages can be published under other names (e.g. Bunosaurus packages,
    // "@azerion/bunosaurus-core"), and installed with npm aliases
    const publishedPrefix = name.replace(/core$/, '');
    const siteDocusaurusPackagesForUpdate = Object.keys({
      ...sitePkg.dependencies,
      ...sitePkg.devDependencies,
    })
      .filter((p) => p.startsWith('@docusaurus/'))
      .map((p) =>
        publishedPrefix === '@docusaurus/'
          ? `${p}@latest`
          : `${p}@npm:${publishedPrefix}${p.slice('@docusaurus/'.length)}@latest`,
      )
      .join(' ');

    const getUpgradeCommand = async () =>
      `bun add ${siteDocusaurusPackagesForUpdate}`;

    /** @type {import('boxen').Options} */
    const boxenOptions = {
      padding: 1,
      margin: 1,
      align: 'center',
      borderColor: 'yellow',
      borderStyle: {
        topLeft: ' ',
        topRight: ' ',
        bottomLeft: ' ',
        bottomRight: ' ',
        top: '-',
        bottom: '-',
        left: ' ',
        right: ' ',
      },
    };

    const docusaurusUpdateMessage = boxen(
      `Update available ${logger.dim(
        `${notifier.update.current}`,
      )} → ${logger.green(`${notifier.update.latest}`)}

  To upgrade Docusaurus packages with the latest version, run the following command:
  ${logger.code(await getUpgradeCommand())}`,
      boxenOptions,
    );

    console.log(docusaurusUpdateMessage);
  }

  // Docusaurus runs on Bun only
  if (typeof Bun === 'undefined') {
    logger.error('Docusaurus must be run with Bun.');
    logger.info`Use code=${'bun run docusaurus <command>'} or code=${'bunx docusaurus <command>'}.`;
    process.exit(1);
  }
  if (!semver.satisfies(Bun.version, requiredVersion)) {
    logger.error('Minimum Bun version not met :(');
    logger.info`You are using Bun number=${Bun.version}, Requirement: Bun number=${requiredVersion}.`;
    process.exit(1);
  }
}

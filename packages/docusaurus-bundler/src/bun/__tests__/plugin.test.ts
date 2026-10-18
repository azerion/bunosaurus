/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {afterAll, describe, expect, it} from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {fs} from '@docusaurus/fs';
import {getAssetRuleUtils} from '@docusaurus/utils';
import {createDocusaurusBunPlugin} from '../plugin';
import {AssetEmitter} from '../assets';
import {interpretWebpackConfig} from '../webpackCompat';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bun-plugin-test-'));

const errorLoader = path.join(
  __dirname,
  '__fixtures__',
  'loaders',
  'errorLoader.js',
);

// Builds and runs an entry module, returns what it exports
async function buildAndRun(
  name: string,
  files: {[file: string]: string},
): Promise<{exports: {[key: string]: unknown}; outDir: string}> {
  const siteDir = path.join(tmpDir, name);
  const outDir = path.join(siteDir, 'build');
  await Promise.all(
    Object.entries(files).map(([file, content]) =>
      Bun.write(path.join(siteDir, file), content),
    ),
  );
  // The built-in asset rules, with an SVG rule wrapped like SVGR does
  const config = {module: {rules: [getAssetRuleUtils(false).rules.assets()]}};
  const svgRule = (config.module.rules[0]!.oneOf as {test?: unknown}[]).find(
    (rule) => String(rule.test) === String(/\.svg$/i),
  )!;
  Object.assign(svgRule, {
    oneOf: [
      {issuer: {and: [/\.(?:tsx?|jsx?|mdx?)$/i]}, use: [errorLoader]},
      {...svgRule},
    ],
  });
  const {rules} = interpretWebpackConfig(config);
  const assetEmitter = new AssetEmitter({outDir, publicPath: '/base/'});
  const output = await Bun.build({
    entrypoints: [path.join(siteDir, 'entry.js')],
    outdir: outDir,
    target: 'bun',
    format: 'esm',
    plugins: [
      createDocusaurusBunPlugin({
        isServer: true,
        mode: 'production',
        siteDir,
        rootDirs: [],
        aliases: {'@site': siteDir},
        sitePackages: [],
        rules,
        contextReplacements: [],
        postCssPlugins: [],
        assetEmitter,
      }),
    ],
  });
  expect(output.success).toBe(true);
  await assetEmitter.writeAll();
  return {
    exports: (await import(path.join(outDir, 'entry.js'))) as {
      [key: string]: unknown;
    },
    outDir,
  };
}

const png = '\x89PNG fake image';

describe('createDocusaurusBunPlugin assets', () => {
  afterAll(() => fs.rm(tmpDir, {recursive: true, force: true}));

  it('returns asset URLs for require() and imports', async () => {
    const {exports} = await buildAndRun('require', {
      'img.png': png,
      'entry.js': `
import imported from './img.png';
export const required = require('./img.png');
export const requiredDefault = require('./img.png').default;
export {imported};
`,
    });
    expect(exports.required).toMatch(/^\/base\/assets\/images\/img-\w+\.png$/);
    expect(exports.imported).toBe(exports.required);
    // Like Webpack asset modules
    expect(exports.requiredDefault).toBeUndefined();
  });

  it('handles createAssetRequest() requests, without module rules', async () => {
    const {exports, outDir} = await buildAndRun('asset-request', {
      'img.png': png,
      'logo.svg': '<svg/>',
      'data.json': '{"a": 1}',
      'entry.js': `
export const image = require('!./img.png?docusaurus-asset=image');
export const imageFile = require('!./img.png?w=10&docusaurus-asset=image-file');
export const file = require('!./img.png?docusaurus-asset=file');
export const svg = require('!./logo.svg?docusaurus-asset=image');
export const json = require('!./data.json?docusaurus-asset=file');
`,
    });
    expect(exports.image).toMatch(/^\/base\/assets\/images\/img-\w+\.png$/);
    expect(exports.imageFile).toBe(exports.image);
    expect(exports.file).toMatch(/^\/base\/assets\/files\/img-\w+\.png$/);
    expect(exports.svg).toMatch(/^\/base\/assets\/images\/logo-\w+\.svg$/);
    expect(exports.json).toMatch(/^\/base\/assets\/files\/data-\w+\.json$/);
    await expect(
      Bun.file(path.join(outDir, (exports.file as string).slice(6))).text(),
    ).resolves.toBe(png);
  });

  it('supports new URL(path, import.meta.url)', async () => {
    const {exports} = await buildAndRun('new-url', {
      'img/img.png': png,
      'img/logo.svg': '<svg/>',
      'entry.js': `
export const relative = new URL('./img/img.png', import.meta.url);
export const bare = new URL('img/img.png', import.meta.url).href;
export const alias = new URL('@site/img/img.png', import.meta.url).href;
// Not transformed by the SVGR-like rule
export const svg = new URL( "./img/logo.svg" , import.meta.url ).href;
export const external = new URL('https://example.com/a.png', import.meta.url).href;
`,
    });
    const url = exports.relative as URL;
    expect(url.href).toMatch(/^\/base\/assets\/images\/img-\w+\.png$/);
    expect(url.pathname).toBe(url.href);
    expect(String(url)).toBe(url.href);
    expect(url instanceof URL).toBe(true);
    expect(exports.bare).toBe(url.href);
    expect(exports.alias).toBe(url.href);
    expect(exports.svg).toMatch(/^\/base\/assets\/images\/logo-\w+\.svg$/);
    expect(exports.external).toBe('https://example.com/a.png');
  });
});

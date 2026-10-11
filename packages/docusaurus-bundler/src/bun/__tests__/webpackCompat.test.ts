/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {describe, expect, it} from 'vitest';
import {matchCondition} from '../conditions';
import {
  BundlerInstanceShim,
  interpretWebpackConfig,
  resolveRuleLoaders,
} from '../webpackCompat';

describe('matchCondition', () => {
  it('matches regexps, strings (prefix), functions and arrays', () => {
    expect(matchCondition(/\.mdx?$/, '/site/doc.md')).toBe(true);
    expect(matchCondition('/site/docs', '/site/docs/a.md')).toBe(true);
    expect(matchCondition('/site/docs', '/site/blog/a.md')).toBe(false);
    expect(matchCondition((v) => v.includes('x'), 'abx')).toBe(true);
    expect(matchCondition([/\.js$/, /\.md$/], 'a.md')).toBe(true);
    expect(matchCondition(undefined, 'anything')).toBe(true);
  });

  it('matches and/or/not conditions', () => {
    expect(matchCondition({and: [/\.md$/, '/site']}, '/site/a.md')).toBe(true);
    expect(matchCondition({and: [/\.md$/, '/other']}, '/site/a.md')).toBe(
      false,
    );
    expect(matchCondition({or: [/\.js$/, /\.md$/]}, 'a.md')).toBe(true);
    expect(matchCondition({not: /node_modules/}, '/node_modules/a.js')).toBe(
      false,
    );
  });
});

describe('interpretWebpackConfig', () => {
  it('extracts aliases, rules and supported plugins', () => {
    const contributions = interpretWebpackConfig({
      resolve: {alias: {'~docs': '/site/.docusaurus/docs', '@x': ['/x']}},
      module: {
        rules: [
          {test: /\.mdx?$/, include: ['/site/docs'], use: ['mdx-loader']},
          {
            test: /\.svg$/,
            oneOf: [
              {
                issuer: /\.tsx?$/,
                use: [{loader: 'svgr-loader', options: {svgo: true}}],
              },
              {use: [{loader: '/node_modules/url-loader/index.js'}]},
            ],
          },
        ],
      },
      plugins: [
        new BundlerInstanceShim.DefinePlugin({'process.env.X': '"x"', Y: 1}),
        new BundlerInstanceShim.EnvironmentPlugin({PWA_DEBUG: false}),
        new BundlerInstanceShim.ContextReplacementPlugin(
          /prismjs[\\/]components$/,
          /^\.\/(prism-java)$/,
        ),
      ],
    });
    expect(contributions.aliases).toEqual({
      '~docs': '/site/.docusaurus/docs',
      '@x': '/x',
    });
    expect(contributions.define).toEqual({
      'process.env.X': '"x"',
      Y: '1',
      'process.env.PWA_DEBUG': 'false',
    });
    expect(contributions.contextReplacements).toHaveLength(1);
    expect(contributions.rules).toHaveLength(2);
  });
});

describe('resolveRuleLoaders', () => {
  const {rules} = interpretWebpackConfig({
    module: {
      rules: [
        {test: /\.mdx?$/, include: ['/site/docs'], use: ['mdx-loader']},
        {test: /\.md$/, resourceQuery: /truncated/, use: ['truncate-loader']},
        {
          test: /\.svg$/,
          oneOf: [
            {issuer: /\.tsx?$/, use: ['svgr-loader']},
            {use: ['/node_modules/file-loader/index.js']},
          ],
        },
      ],
    },
  });

  function loaders(resourcePath: string, issuer: string, query = '') {
    return resolveRuleLoaders({
      rules,
      resourcePath,
      resourceQuery: query,
      issuer,
    }).map((l) => l.loader);
  }

  it('applies all matching rules, in order', () => {
    expect(loaders('/site/docs/a.md', '/site/registry.js')).toEqual([
      'mdx-loader',
    ]);
    expect(loaders('/site/docs/a.md', '/site/r.js', '?truncated=true')).toEqual(
      ['mdx-loader', 'truncate-loader'],
    );
    expect(loaders('/site/blog/a.md', '/site/r.js')).toEqual([]);
  });

  it('picks the first matching oneOf rule and drops asset loaders', () => {
    expect(loaders('/site/logo.svg', '/site/src/Page.tsx')).toEqual([
      'svgr-loader',
    ]);
    expect(loaders('/site/logo.svg', '/site/src/styles.css')).toEqual([]);
  });
});

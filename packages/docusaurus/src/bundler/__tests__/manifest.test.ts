/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {describe, expect, it} from 'vitest';
import path from 'node:path';
import {createClientManifest} from '../manifest';
import type {BuildMetafile} from 'bun';

describe('createClientManifest', () => {
  const clientEntryPath = path.resolve('lib/client/clientEntry.js');
  const docPath = path.resolve('docs/intro.md');

  // Simplified Bun metafile: entry imports a shared chunk, and lazily imports
  // 2 route chunks, one of them being an MDX doc compiled by our loader
  const metafile = {
    inputs: {},
    outputs: {
      './assets/js/clientEntry.aaa.js': {
        entryPoint: 'lib/client/clientEntry.js',
        cssBundle: './assets/js/clientEntry.bbb.css',
        imports: [
          {path: './assets/js/shared.ccc.js', kind: 'import-statement'},
          {path: './assets/js/intro.ddd.js', kind: 'dynamic-import'},
        ],
        inputs: {},
        bytes: 1,
      },
      './assets/js/shared.ccc.js': {imports: [], inputs: {}, bytes: 1},
      './assets/js/intro.ddd.js': {
        entryPoint: `docusaurus-loader:${docPath}?__docusaurus_chain=0`,
        imports: [
          {path: './assets/js/shared.ccc.js', kind: 'import-statement'},
          {path: './assets/js/mdxDeps.eee.js', kind: 'import-statement'},
        ],
        inputs: {},
        bytes: 1,
      },
      './assets/js/mdxDeps.eee.js': {imports: [], inputs: {}, bytes: 1},
      './assets/js/data.fff.js': {
        entryPoint: '.docusaurus/data.json',
        imports: [],
        inputs: {},
        bytes: 1,
      },
    },
  } as unknown as BuildMetafile;

  const {manifest, chunkMap} = createClientManifest({
    metafile,
    clientEntryPath,
    dynamicImports: new Map([
      [
        '@site/docs/intro.md',
        `docusaurus-loader:${docPath}?__docusaurus_chain=0`,
      ],
      ['@generated/data.json', path.resolve('.docusaurus/data.json')],
    ]),
    registry: {
      'content---intro': '@site/docs/intro.md',
      'data---123': '@generated/data.json',
    },
  });

  it('collects the entry assets', () => {
    expect(manifest.entry).toEqual({
      js: ['assets/js/clientEntry.aaa.js'],
      css: ['assets/js/clientEntry.bbb.css'],
    });
  });

  it('maps registry modules to their chunks, excluding entry chunks', () => {
    expect(manifest.modules).toEqual({
      '@site/docs/intro.md': [
        'assets/js/intro.ddd.js',
        'assets/js/mdxDeps.eee.js',
      ],
      '@generated/data.json': ['assets/js/data.fff.js'],
    });
  });

  it('creates a compact chunk map for prefetching', () => {
    expect(chunkMap).toEqual({
      files: [
        'assets/js/intro.ddd.js',
        'assets/js/mdxDeps.eee.js',
        'assets/js/data.fff.js',
      ],
      chunks: {'content---intro': [0, 1], 'data---123': [2]},
    });
  });
});

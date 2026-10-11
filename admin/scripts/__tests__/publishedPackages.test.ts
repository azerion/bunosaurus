/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {describe, expect, it} from 'vitest';
import {getPublishedName, toPublishedPackageJson} from '../publishedPackages';

describe('getPublishedName', () => {
  it('renames @docusaurus packages', () => {
    expect(getPublishedName('@docusaurus/core')).toBe(
      '@azerion/bunosaurus-core',
    );
    expect(getPublishedName('@docusaurus/plugin-content-docs')).toBe(
      '@azerion/bunosaurus-plugin-content-docs',
    );
  });

  it('renames the initializer', () => {
    expect(getPublishedName('create-docusaurus')).toBe(
      '@azerion/create-bunosaurus',
    );
  });

  it('rejects other packages', () => {
    expect(() => getPublishedName('react')).toThrow();
  });
});

describe('toPublishedPackageJson', () => {
  const publishedNames = new Set([
    '@docusaurus/core',
    '@docusaurus/utils',
    '@docusaurus/types',
  ]);

  it('renames the package and aliases its published dependencies', () => {
    expect(
      toPublishedPackageJson(
        {
          name: '@docusaurus/core',
          version: '1.0.0',
          dependencies: {'@docusaurus/utils': '1.0.0', react: '^19.3.0'},
          devDependencies: {'@docusaurus/types': '1.0.0'},
          peerDependencies: {'react-dom': '^19.3.0'},
        },
        publishedNames,
      ),
    ).toEqual({
      name: '@azerion/bunosaurus-core',
      version: '1.0.0',
      dependencies: {
        '@docusaurus/utils': 'npm:@azerion/bunosaurus-utils@1.0.0',
        react: '^19.3.0',
      },
      devDependencies: {
        '@docusaurus/types': 'npm:@azerion/bunosaurus-types@1.0.0',
      },
      peerDependencies: {'react-dom': '^19.3.0'},
    });
  });

  it('points to the Bunosaurus repository', () => {
    expect(
      toPublishedPackageJson(
        {
          name: '@docusaurus/utils',
          version: '1.0.0',
          repository: {
            type: 'git',
            url: 'https://github.com/facebook/docusaurus.git',
            directory: 'packages/docusaurus-utils',
          },
          bugs: {url: 'https://github.com/facebook/docusaurus/issues'},
        },
        publishedNames,
      ),
    ).toMatchObject({
      repository: {
        type: 'git',
        url: 'https://github.com/azerion/bunosaurus.git',
        directory: 'packages/docusaurus-utils',
      },
      bugs: {url: 'https://github.com/azerion/bunosaurus/issues'},
    });
  });

  it('keeps the name of unpublished packages (templates)', () => {
    expect(
      toPublishedPackageJson(
        {
          name: 'docusaurus-2-classic-template',
          version: '1.0.0',
          dependencies: {'@docusaurus/core': '1.0.0'},
        },
        publishedNames,
      ),
    ).toEqual({
      name: 'docusaurus-2-classic-template',
      version: '1.0.0',
      dependencies: {
        '@docusaurus/core': 'npm:@azerion/bunosaurus-core@1.0.0',
      },
    });
  });

  it('rejects unresolved workspace ranges', () => {
    expect(() =>
      toPublishedPackageJson(
        {
          name: '@docusaurus/core',
          version: '1.0.0',
          dependencies: {'@docusaurus/utils': 'workspace:*'},
        },
        publishedNames,
      ),
    ).toThrow(/Unresolved workspace/);
  });
});

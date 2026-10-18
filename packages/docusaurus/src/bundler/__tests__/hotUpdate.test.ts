/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {afterAll, describe, expect, it} from 'vitest';
import path from 'node:path';
import {fs} from '@docusaurus/fs';
import {
  computeHotUpdate,
  writeDevBuildOutput,
  type DevBuildSnapshot,
} from '../hotUpdate';

function createSnapshot({
  files,
  modules = {'@site/docs/a.md': 'assets/js/a.aaaaaaaa.js'},
  cssHash = 'css1',
}: {
  files: {[outputPath: string]: [contentHash: string, inputs: string[]]};
  modules?: {[modulePath: string]: string};
  cssHash?: string;
}): DevBuildSnapshot {
  return {
    files: new Map(
      Object.entries(files).map(([outputPath, [contentHash, inputs]]) => [
        outputPath,
        {contentHash, inputs},
      ]),
    ),
    entryPath: 'assets/js/main.js',
    cssPath: 'assets/js/main.css',
    cssHash,
    modules: new Map(Object.entries(modules)),
  };
}

const baseFiles = {
  'assets/js/main.js': ['main1', ['/src/clientEntry.js', '/src/registry.js']],
  'assets/js/a.aaaaaaaa.js': ['a1', ['/docs/a.md']],
  'assets/js/shared.ssssssss.js': ['shared1', ['/src/Layout.js']],
} as const;

function withFiles(
  overrides: {[outputPath: string]: [string, string[]] | undefined} = {},
) {
  const result: {[outputPath: string]: [string, string[]]} = {};
  Object.entries({...baseFiles, ...overrides}).forEach(([key, value]) => {
    if (value) {
      result[key] = [value[0], [...value[1]]];
    }
  });
  return result;
}

describe('computeHotUpdate', () => {
  const prev = createSnapshot({files: withFiles()});

  it('reloads after the initial build', () => {
    expect(computeHotUpdate(undefined, prev)).toEqual({
      type: 'reload',
      reason: 'initial build',
    });
  });

  it('does nothing when nothing changed', () => {
    expect(
      computeHotUpdate(prev, createSnapshot({files: withFiles()})),
    ).toEqual({
      type: 'none',
    });
  });

  it('hot-updates the chunk of a route module', () => {
    const next = createSnapshot({
      files: withFiles({'assets/js/a.aaaaaaaa.js': ['a2', ['/docs/a.md']]}),
    });
    expect(computeHotUpdate(prev, next)).toEqual({
      type: 'hot',
      modules: {'@site/docs/a.md': 'assets/js/a.aaaaaaaa.js?t=a2'},
      cssChanged: false,
    });
  });

  it('hot-updates the CSS', () => {
    const next = createSnapshot({files: withFiles(), cssHash: 'css2'});
    expect(computeHotUpdate(prev, next)).toEqual({
      type: 'hot',
      modules: {},
      cssChanged: true,
    });
  });

  it('reloads when the entry changed', () => {
    const next = createSnapshot({
      files: withFiles({
        'assets/js/main.js': ['main2', ['/src/clientEntry.js']],
      }),
    });
    expect(computeHotUpdate(prev, next)).toEqual({
      type: 'reload',
      reason: 'app entry changed',
    });
  });

  it('reloads when a shared chunk changed', () => {
    const next = createSnapshot({
      files: withFiles({
        'assets/js/shared.ssssssss.js': ['shared2', ['/src/Layout.js']],
      }),
    });
    expect(computeHotUpdate(prev, next)).toEqual({
      type: 'reload',
      reason: 'shared chunk changed (assets/js/shared.ssssssss.js)',
    });
  });

  it('reloads for new route modules', () => {
    const next = createSnapshot({
      files: withFiles(),
      modules: {
        '@site/docs/a.md': 'assets/js/a.aaaaaaaa.js',
        '@site/docs/b.md': 'assets/js/b.bbbbbbbb.js',
      },
    });
    expect(computeHotUpdate(prev, next)).toEqual({
      type: 'reload',
      reason: 'new route module @site/docs/b.md',
    });
  });

  it('reloads when a module moved to a new chunk', () => {
    const next = createSnapshot({
      files: withFiles({
        'assets/js/a.aaaaaaaa.js': ['a2', ['/docs/a.md']],
        'assets/js/new.nnnnnnnn.js': ['new1', ['/src/Layout.js']],
      }),
    });
    expect(computeHotUpdate(prev, next)).toMatchObject({type: 'reload'});
  });

  it('accepts new chunks of new modules', () => {
    const next = createSnapshot({
      files: withFiles({
        'assets/js/a.aaaaaaaa.js': ['a2', ['/docs/a.md']],
        'assets/js/new.nnnnnnnn.js': ['new1', ['/src/NewComponent.js']],
      }),
    });
    expect(computeHotUpdate(prev, next)).toEqual({
      type: 'hot',
      modules: {'@site/docs/a.md': 'assets/js/a.aaaaaaaa.js?t=a2'},
      cssChanged: false,
    });
  });
});

describe('writeDevBuildOutput', () => {
  // Not in os.tmpdir(): Bun metafile paths are relative to the cwd, they
  // can't point to another drive (Windows CI: repo on D:, temp dir on C:)
  const tmpDir = path.join(__dirname, `.tmp-hot-update-test-${process.pid}`);
  afterAll(() => fs.rm(tmpDir, {recursive: true, force: true}));

  async function build(routeAContent: string) {
    const srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir, {recursive: true});
    await Bun.write(
      path.join(srcDir, 'shared.js'),
      'export const shared = (x) => "shared:" + x;',
    );
    // Like the Docusaurus registry: bundled in the entry, imported by routes
    await Bun.write(
      path.join(srcDir, 'registry.js'),
      'export default {a: () => import("./a.js"), b: () => import("./b.js")};',
    );
    await Bun.write(
      path.join(srcDir, 'entry.js'),
      'import registry from "./registry.js"; import {shared} from "./shared.js"; console.log(shared(Object.keys(registry)));',
    );
    await Bun.write(path.join(srcDir, 'a.js'), routeAContent);
    await Bun.write(
      path.join(srcDir, 'b.js'),
      'import registry from "./registry.js"; export default () => Object.keys(registry);',
    );
    const output = await Bun.build({
      entrypoints: [path.join(srcDir, 'entry.js')],
      splitting: true,
      format: 'esm',
      target: 'browser',
      modulePreload: false,
      publicPath: '/',
      metafile: true,
      naming: {
        entry: 'assets/js/main.[ext]',
        chunk: 'assets/js/[name].[hash].[ext]',
      },
    });
    return {output, srcDir};
  }

  it('keeps chunk URLs stable across rebuilds', async () => {
    const outDir = path.join(tmpDir, 'out');
    const writtenFiles = new Map<string, string>();
    const write = async (routeAContent: string) => {
      const {output, srcDir} = await build(routeAContent);
      return writeDevBuildOutput({
        output,
        outDir,
        clientEntryPath: path.join(srcDir, 'entry.js'),
        dynamicImports: new Map([
          ['@site/a.js', path.join(srcDir, 'a.js')],
          ['@site/b.js', path.join(srcDir, 'b.js')],
        ]),
        writtenFiles,
      });
    };

    const first = await write(
      'import {shared} from "./shared.js"; export default () => shared("a1");',
    );
    const second = await write(
      'import {shared} from "./shared.js"; export default () => shared("a2");',
    );

    expect([...second.files.keys()].sort()).toEqual(
      [...first.files.keys()].sort(),
    );
    const routeA = first.modules.get('@site/a.js')!;
    expect(second.modules.get('@site/a.js')).toBe(routeA);
    await expect(Bun.file(path.join(outDir, routeA)).text()).resolves.toContain(
      'a2',
    );
    expect(computeHotUpdate(first, second)).toEqual({
      type: 'hot',
      modules: {
        '@site/a.js': `${routeA}?t=${second.files.get(routeA)!.contentHash}`,
      },
      cssChanged: false,
    });
  });
});

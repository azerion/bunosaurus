/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {describe, expect, it, vi} from 'vitest';
import path from 'node:path';
import {runLoaders} from '../loaderRunner';
import {LoaderCache} from '../loaderCache';

const fixture = (name: string) =>
  path.join(__dirname, '__fixtures__', 'loaders', name);

const params = {
  resourcePath: '/site/docs/doc.md',
  resourceQuery: '?truncated=true',
  content: Buffer.from('hello'),
  compilerName: 'client' as const,
  mode: 'production' as const,
  rootContext: '/site',
};

describe('runLoaders', () => {
  it('runs loaders right to left with sync, async and promise APIs', async () => {
    const result = await runLoaders({
      ...params,
      loaders: [
        {loader: fixture('promiseLoader.js'), options: {suffix: '!'}},
        {loader: fixture('asyncLoader.js')},
        {loader: fixture('syncLoader.js')},
      ],
    });
    expect(result).toBe('async(sync(hello))!');
  });

  it('exposes the loader context and query string options', async () => {
    const result = await runLoaders({
      ...params,
      loaders: [{loader: fixture('contextLoader.js'), options: '?a=1&b=2'}],
    });
    expect(JSON.parse(result as string)).toEqual({
      compilerName: 'client',
      resourcePath: '/site/docs/doc.md',
      resourceQuery: '?truncated=true',
      options: {a: '1', b: '2'},
    });
  });

  it('forwards emitted files', async () => {
    const onEmitFile = vi.fn();
    await runLoaders({
      ...params,
      loaders: [{loader: fixture('emitLoader.js')}],
      onEmitFile,
    });
    expect(onEmitFile).toHaveBeenCalledWith('assets/out.txt', 'content');
  });

  it('rejects loader errors', async () => {
    await expect(
      runLoaders({...params, loaders: [{loader: fixture('errorLoader.js')}]}),
    ).rejects.toThrow('loader failure');
  });
});

describe('LoaderCache', () => {
  it('reuses results for the same key and content', async () => {
    const cache = new LoaderCache();
    const run = vi.fn(async () => ({contents: 'result', cacheable: true}));
    const content = Buffer.from('a');
    await expect(cache.get('key', content, run)).resolves.toBe('result');
    await expect(cache.get('key', content, run)).resolves.toBe('result');
    expect(run).toHaveBeenCalledTimes(1);
    await cache.get('key', Buffer.from('b'), run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('persists cacheable results on disk', async () => {
    const diskDir = path.join(
      await import('node:os').then((os) => os.tmpdir()),
      `docusaurus-loader-cache-test-${Date.now()}`,
    );
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(diskDir, {recursive: true}),
    );
    const run = vi.fn(async () => ({contents: 'persisted', cacheable: true}));
    await new LoaderCache({diskDir}).get('key', Buffer.from('a'), run);
    // A new cache instance (next build) reads the result from disk
    await expect(
      new LoaderCache({diskDir}).get('key', Buffer.from('a'), run),
    ).resolves.toBe('persisted');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

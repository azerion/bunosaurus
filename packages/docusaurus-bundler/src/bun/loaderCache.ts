/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {fs} from '@docusaurus/fs';

export type LoaderRunResult = {
  contents: string;
  /** False when the loaders emitted files: the result can't be replayed */
  cacheable: boolean;
};

/**
 * Caches the results of Webpack loaders (mostly MDX compilation, the most
 * expensive part of bundling a Docusaurus site):
 * - in memory: shared by the client and server bundles, and across dev
 *   server rebuilds
 * - on disk (optional): across builds, invalidated by a global key that
 *   captures everything that can affect loader outputs (versions, site config,
 *   routes...) in addition to the file content
 */
export class LoaderCache {
  private readonly memory = new Map<
    string,
    {contentHash: string; promise: Promise<string>}
  >();

  private readonly diskDir: string | undefined;

  constructor(options: {diskDir?: string} = {}) {
    this.diskDir = options.diskDir;
  }

  async get(
    key: string,
    content: Uint8Array,
    run: () => Promise<LoaderRunResult>,
  ): Promise<string> {
    const contentHash = Bun.hash(content).toString(36);
    const entry = this.memory.get(key);
    if (entry && entry.contentHash === contentHash) {
      return entry.promise;
    }
    const promise = this.load(key, contentHash, run);
    this.memory.set(key, {contentHash, promise});
    promise.catch(() => this.memory.delete(key));
    return promise;
  }

  private async load(
    key: string,
    contentHash: string,
    run: () => Promise<LoaderRunResult>,
  ): Promise<string> {
    const diskPath = this.diskDir
      ? path.join(
          this.diskDir,
          `${Bun.hash(`${key}|${contentHash}`).toString(36)}.txt`,
        )
      : undefined;
    if (diskPath) {
      const file = Bun.file(diskPath);
      if (await file.exists()) {
        return file.text();
      }
    }
    const result = await run();
    if (diskPath && result.cacheable) {
      // Write atomically: concurrent builds may share the cache dir
      const tmpPath = `${diskPath}.${process.pid}.tmp`;
      await Bun.write(tmpPath, result.contents);
      await fs.rename(tmpPath, diskPath);
    }
    return result.contents;
  }
}

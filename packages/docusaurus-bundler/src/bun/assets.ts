/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {fs} from '@docusaurus/fs';

export type AssetFolder = 'images' | 'files' | 'fonts' | 'medias';

// Same extensions as the Docusaurus asset rules
// See @docusaurus/utils getAssetRuleUtils()
const AssetFolderTests: [AssetFolder, RegExp][] = [
  ['images', /\.(?:ico|jpe?g|png|gif|webp|avif|svg)$/i],
  ['fonts', /\.(?:woff2?|eot|ttf|otf)$/i],
  [
    'medias',
    /\.(?:mp4|avi|mov|mkv|mpg|mpeg|vob|wmv|m4v|webm|ogv|wav|mp3|m4a|aac|oga|flac)$/i,
  ],
  ['files', /\.(?:pdf|docx?|xlsx?|zip|rar)$/i],
];

export function getAssetFolder(filePath: string): AssetFolder | undefined {
  return AssetFolderTests.find(([, test]) => test.test(filePath))?.[0];
}

export function isAssetPath(filePath: string): boolean {
  return getAssetFolder(filePath) !== undefined;
}

type EmittedAsset = {
  source: string;
  outputPath: string;
  url: string;
  /** URL to use in the CSS bundle, emitted in the assets/js folder */
  cssUrl: string;
};

// "./" (hash router): URLs are relative to the HTML document
function isRelativePublicPath(publicPath: string): boolean {
  return !publicPath.startsWith('/') && !/^[a-z][a-z\d+.-]*:/i.test(publicPath);
}

/**
 * Computes stable, content-hashed URLs for imported assets
 * (images, fonts, files...) and copies them to the output directory.
 *
 * The client and server bundles share the same emitter so that both
 * compilations agree on asset URLs, and each file is hashed only once.
 */
export class AssetEmitter {
  private readonly assets = new Map<string, Promise<EmittedAsset>>();
  // Files emitted by Webpack loaders (this.emitFile), path relative to outDir
  private readonly emittedFiles = new Map<string, string | Buffer>();

  private readonly options: {outDir: string; publicPath: string};

  constructor(options: {outDir: string; publicPath: string}) {
    this.options = options;
  }

  /**
   * @param folder overrides the folder inferred from the file extension, e.g.
   * a PNG linked from Markdown is emitted as a file, not an image
   */
  getAsset(source: string, folder?: AssetFolder): Promise<EmittedAsset> {
    const key = folder ? `${folder}:${source}` : source;
    let asset = this.assets.get(key);
    if (!asset) {
      asset = this.createAsset(source, folder);
      this.assets.set(key, asset);
    }
    return asset;
  }

  private async createAsset(
    source: string,
    folderParam?: AssetFolder,
  ): Promise<EmittedAsset> {
    const content = await Bun.file(source).bytes();
    const hash = Bun.hash(content).toString(16).padStart(16, '0').slice(0, 8);
    const ext = path.extname(source);
    const name = path.basename(source, ext);
    const folder = folderParam ?? getAssetFolder(source) ?? 'files';
    const relativePath = path.posix.join(
      'assets',
      folder,
      `${name}-${hash}${ext}`,
    );
    return {
      source,
      outputPath: path.join(this.options.outDir, relativePath),
      url: `${this.options.publicPath}${relativePath}`,
      // Relative URLs in CSS are resolved against the CSS file URL
      cssUrl: isRelativePublicPath(this.options.publicPath)
        ? `../../${relativePath}`
        : `${this.options.publicPath}${relativePath}`,
    };
  }

  emitFile(name: string, content: string | Buffer): void {
    this.emittedFiles.set(name, content);
  }

  /**
   * Copies all the assets referenced so far to the output directory
   */
  async writeAll(): Promise<void> {
    const assets = await Promise.all(this.assets.values());
    const emitted = [...this.emittedFiles].map(([name, content]) => ({
      outputPath: path.join(this.options.outDir, name),
      content,
    }));
    const dirs = new Set(
      [...assets, ...emitted].map((a) => path.dirname(a.outputPath)),
    );
    await Promise.all([...dirs].map((dir) => fs.mkdir(dir, {recursive: true})));
    await Promise.all([
      ...assets.map((asset) =>
        Bun.write(asset.outputPath, Bun.file(asset.source)),
      ),
      ...emitted.map((file) => Bun.write(file.outputPath, file.content)),
    ]);
  }
}

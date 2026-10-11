/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {DOCUSAURUS_VERSION} from '@docusaurus/utils';
import {PerfLogger} from '@docusaurus/logger';
import {readJSON} from '@docusaurus/fs';
import DefaultSSGTemplate from './ssgTemplate.html';
import type {ClientManifest} from '../bundler/manifest';
import type {Props} from '@docusaurus/types';

// Keep these params serializable
// This makes it possible to use workers
export type SSGParams = {
  trailingSlash: boolean | undefined;
  manifest: ClientManifest;
  headTags: string;
  preBodyTags: string;
  postBodyTags: string;
  outDir: string;
  baseUrl: string;
  noIndex: boolean;
  DOCUSAURUS_VERSION: string;

  serverBundlePath: string;
  ssgTemplateContent: string;
};

export async function createSSGParams({
  props,
  serverBundlePath,
  clientManifestPath,
}: {
  props: Props;
  serverBundlePath: string;
  clientManifestPath: string;
}): Promise<SSGParams> {
  const manifest = await PerfLogger.async(
    'Read client manifest',
    () => readJSON(clientManifestPath) as Promise<ClientManifest>,
  );

  const params: SSGParams = {
    trailingSlash: props.siteConfig.trailingSlash,
    outDir: props.outDir,
    baseUrl: props.baseUrl,
    manifest,
    headTags: manifest.chunkMapUrl
      ? `${props.headTags}\n<meta name="docusaurus-chunk-map" content="${manifest.chunkMapUrl}">`
      : props.headTags,
    preBodyTags: props.preBodyTags,
    postBodyTags: props.postBodyTags,
    ssgTemplateContent: props.siteConfig.ssrTemplate ?? DefaultSSGTemplate,
    noIndex: props.siteConfig.noIndex,
    DOCUSAURUS_VERSION,
    serverBundlePath,
  };

  // Useless but ensures that SSG params remain serializable
  return structuredClone(params);
}

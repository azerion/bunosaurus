/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {matchRoutes} from 'react-router-config';
import routesChunkNames from '@generated/routesChunkNames';
import routes from '@generated/routes';
import prefetchHelper from './prefetch';
import preloadHelper from './preload';
import flat from './flat';

const fetched = new Set<string>();
const loaded = new Set<string>();

declare global {
  // See https://github.com/microsoft/TypeScript/issues/56962
  interface Navigator {
    connection?: {effectiveType: string; saveData: boolean};
  }
}

// If user is on slow or constrained connection.
const isSlowConnection = () =>
  navigator.connection?.effectiveType.includes('2g') ||
  navigator.connection?.saveData;

const canPrefetch = (routePath: string) =>
  !isSlowConnection() && !loaded.has(routePath) && !fetched.has(routePath);

const canPreload = (routePath: string) =>
  !isSlowConnection() && !loaded.has(routePath);

type ChunkMap = {files: string[]; chunks: {[chunkName: string]: number[]}};

// The chunk map (chunk name -> asset URLs) is emitted by the bundler, and
// only fetched lazily on the first prefetch, see bundler/manifest.ts
let chunkMapPromise: Promise<ChunkMap | null> | undefined;
function getChunkMap(): Promise<ChunkMap | null> {
  chunkMapPromise ??= (async () => {
    const url = document
      .querySelector<HTMLMetaElement>('meta[name="docusaurus-chunk-map"]')
      ?.getAttribute('content');
    if (!url) {
      return null;
    }
    try {
      const response = await fetch(url);
      return response.ok ? ((await response.json()) as ChunkMap) : null;
    } catch {
      return null;
    }
  })();
  return chunkMapPromise;
}

const getChunkNamesToLoad = (path: string): string[] =>
  Object.entries(routesChunkNames)
    .filter(
      // Remove the last part containing the route hash
      // input: /blog/2018/12/14/Happy-First-Birthday-Slash-fe9
      // output: /blog/2018/12/14/Happy-First-Birthday-Slash
      ([routeNameWithHash]) =>
        routeNameWithHash.replace(/-[^-]+$/, '') === path,
    )
    .flatMap(([, routeChunks]) => Object.values(flat(routeChunks)));

type Docusaurus = Window['docusaurus'];

const prefetch: Docusaurus['prefetch'] = (
  routePath: string,
): false | Promise<void[]> => {
  if (!canPrefetch(routePath)) {
    return false;
  }
  fetched.add(routePath);

  // Find all chunk names needed.
  const matches = matchRoutes(routes, routePath);

  const chunkNamesNeeded = matches.flatMap((match) =>
    getChunkNamesToLoad(match.route.path),
  );

  // Prefetch all chunk asset files needed.
  return getChunkMap().then((chunkMap) => {
    if (!chunkMap) {
      return [];
    }
    const urls = new Set(
      chunkNamesNeeded.flatMap((chunkName) =>
        (chunkMap.chunks[chunkName] ?? []).map(
          (index) => chunkMap.files[index]!,
        ),
      ),
    );
    return Promise.all([...urls].map((url) => prefetchHelper(url)));
  });
};

const preload: Docusaurus['preload'] = (
  routePath: string,
): false | Promise<void[]> => {
  if (!canPreload(routePath)) {
    return false;
  }
  loaded.add(routePath);
  return preloadHelper(routePath);
};

const docusaurus: Window['docusaurus'] = {
  prefetch,
  preload,
};

// This object is directly mounted onto window, better freeze it
export default Object.freeze(docusaurus);

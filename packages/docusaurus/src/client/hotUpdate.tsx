/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {useEffect, useReducer, type ComponentType, type ReactNode} from 'react';
import registry from '@generated/registry';

// Dev server hot updates: the dev server rebuilds the app on file changes, and
// tells the browser which registry modules (route components, MDX content,
// route data...) have a new chunk. We re-import these chunks and re-create
// the route components using them, see bundler/hotUpdate.ts

export type HotUpdateMessage = {
  /** Registry module path -> URL of its updated chunk */
  modules: {[modulePath: string]: string};
};

type HotUpdateListener = (
  changedModules: ReadonlySet<string>,
) => Promise<void> | undefined;

const listeners = new Set<HotUpdateListener>();

export async function applyHotUpdate({
  modules,
}: HotUpdateMessage): Promise<void> {
  const changedModules = new Set(Object.keys(modules));
  if (changedModules.size === 0) {
    return;
  }
  // import() resolves relative URLs against this module, not the document
  // (the hash router uses relative URLs)
  const urls = Object.fromEntries(
    Object.entries(modules).map(([modulePath, url]) => [
      modulePath,
      new URL(url, document.baseURI).href,
    ]),
  );
  Object.values(registry).forEach((entry) => {
    const url = urls[entry[1]];
    if (url) {
      entry[0] = () => import(/* webpackIgnore: true */ url);
    }
  });
  // Rejects on network or module linking errors: the caller reloads the page
  await Promise.all(
    Object.values(urls).map(
      (url) => import(/* webpackIgnore: true */ url) as Promise<unknown>,
    ),
  );
  await Promise.all([...listeners].map((listener) => listener(changedModules)));
}

type RouteComponentWithPreload = ComponentType<object> & {
  // Typed as void by react-loadable, but returns a promise
  preload: () => unknown;
};

/**
 * Wraps a route component, so that it can be re-created when the modules it
 * loads are hot-updated
 */
export function createHotRouteComponent<T>({
  modules,
  create,
}: {
  modules: string[];
  create: () => T;
}): T {
  const createComponent = create as unknown as () => RouteComponentWithPreload;
  let current = createComponent();
  const mountedInstances = new Set<() => void>();

  listeners.add((changedModules) => {
    if (!modules.some((modulePath) => changedModules.has(modulePath))) {
      return undefined;
    }
    // Preload the modules before rendering, to avoid a loading state
    const next = createComponent();
    return Promise.resolve(next.preload()).then(() => {
      current = next;
      mountedInstances.forEach((rerender) => rerender());
    });
  });

  function HotRouteComponent(props: object): ReactNode {
    const [, rerender] = useReducer((count: number) => count + 1, 0);
    useEffect(() => {
      mountedInstances.add(rerender);
      return () => {
        mountedInstances.delete(rerender);
      };
    }, []);
    const Component = current;
    return <Component {...props} />;
  }
  HotRouteComponent.preload = () => current.preload();
  return HotRouteComponent as unknown as T;
}

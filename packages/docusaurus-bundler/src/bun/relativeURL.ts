/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* eslint-disable no-restricted-syntax */

/**
 * What new URL('./img.png', import.meta.url) returns in the bundles: a URL-like
 * object whose href is the asset URL, relative to the site origin.
 * A real URL would be resolved against the bundle file URL, which is a file://
 * URL on the server (SSR).
 * Same as Webpack's RelativeURL runtime ("javascript.url: relative" parser
 * option), see https://github.com/facebook/docusaurus/pull/12655
 *
 * This module is bundled in the site client and server code.
 */
export function RelativeURL(this: {[key: string]: unknown}, url: string): void {
  const realURL = new URL(url, 'x:/');
  const values: {[key: string]: unknown} = {};
  for (const key in realURL) {
    values[key] = realURL[key as keyof URL];
  }
  values.href = url;
  values.pathname = url.replace(/[?#].*/, '');
  values.origin = '';
  values.protocol = '';
  values.toString = () => url;
  values.toJSON = () => url;
  for (const key of Object.keys(values)) {
    Object.defineProperty(this, key, {
      enumerable: true,
      configurable: true,
      value: values[key],
    });
  }
}
RelativeURL.prototype = URL.prototype;

/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import browserslist from 'browserslist';

// Used when the site doesn't provide its own Browserslist config
// See https://web.dev/baseline
const DefaultBrowserslistQueries = ['baseline widely available'];

export function getBrowserslistQueries(): string[] {
  return (
    browserslist.loadConfig({path: process.cwd()}) ?? DefaultBrowserslistQueries
  );
}

/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ReactNode} from 'react';
import {renderToReadableStream} from 'react-dom/server';

// Bun's react-dom/server build exposes the Web Streams API only
// We wait for all Suspense boundaries to be ready: SSG needs the full HTML
// See also https://github.com/facebook/react/issues/31134
// See also https://github.com/facebook/docusaurus/issues/9985#issuecomment-2396367797
export async function renderToHtml(app: ReactNode): Promise<string> {
  let renderError: unknown;
  const stream = await renderToReadableStream(app, {
    onError(error) {
      renderError ??= error;
    },
  });
  await stream.allReady;
  if (renderError) {
    throw renderError;
  }
  return new Response(stream).text();
}

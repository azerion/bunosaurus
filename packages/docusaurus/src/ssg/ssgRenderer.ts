/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {pathToFileURL} from 'node:url';
import pMap from 'p-map';
import logger, {PerfLogger} from '@docusaurus/logger';
import {getHtmlMinifier} from '@docusaurus/bundler';
import {
  compileSSGTemplate,
  renderSSGTemplate,
  type SSGTemplateCompiled,
} from './ssgTemplate';
import {SSGConcurrency} from './ssgEnv';
import {writeStaticFile} from './ssgUtils';
import type {SSGParams} from './ssgParams';
import type {
  AppRenderer,
  PageCollectedData,
  PageCollectedDataInternal,
} from '../common';
import type {HtmlMinifier} from '@docusaurus/bundler';

export type SSGSuccess = {
  success: true;
  pathname: string;
  result: {
    collectedData: PageCollectedData;
    warnings: string[];
    // html: we don't include it on purpose!
    // we don't need to aggregate all html contents in memory!
    // html contents can be GC as soon as they are written to disk
  };
};

// Errors are serialized as plain objects: the Bun worker threads don't
// preserve the message/stack/cause of Error instances posted to the main thread
export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
};

export type SSGError = {
  success: false;
  pathname: string;
  error: SerializedError;
};

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause:
        error.cause !== undefined ? serializeError(error.cause) : undefined,
    };
  }
  return {name: 'Error', message: String(error)};
}

export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message, {
    cause: serialized.cause ? deserializeError(serialized.cause) : undefined,
  });
  error.name = serialized.name;
  if (serialized.stack) {
    error.stack = serialized.stack;
  }
  return error;
}

export type SSGResult = SSGSuccess | SSGError;

async function loadAppRenderer({
  serverBundlePath,
}: {
  serverBundlePath: string;
}): Promise<AppRenderer> {
  // The server bundle is an ES module built for the Bun runtime
  // SSG runs in worker threads that already isolate it from the main process
  const serverEntry = (await PerfLogger.async(
    `Load server bundle`,
    () => import(pathToFileURL(serverBundlePath).href),
  )) as {default?: AppRenderer['render']};

  if (!serverEntry?.default || typeof serverEntry.default !== 'function') {
    throw new Error(
      `Docusaurus Bug: server bundle export from "${serverBundlePath}" must be a function that renders the Docusaurus React app, not ${typeof serverEntry?.default}`,
    );
  }

  return {render: serverEntry.default};
}

// Wall-clock time accumulated per SSG step (overlapping due to concurrency)
// Printed by worker processes with DOCUSAURUS_SSG_PROFILE=true
export const SSGProfile = {render: 0, template: 0, minify: 0, write: 0};

export type SSGRenderer = {
  renderPathnames: (pathnames: string[]) => Promise<SSGResult[]>;
};

export async function loadSSGRenderer({
  params,
}: {
  params: SSGParams;
}): Promise<SSGRenderer> {
  const [appRenderer, htmlMinifier, ssgTemplate] = await Promise.all([
    PerfLogger.async('Load App renderer', () =>
      loadAppRenderer({
        serverBundlePath: params.serverBundlePath,
      }),
    ),
    PerfLogger.async('Load HTML minifier', () => getHtmlMinifier()),
    PerfLogger.async('Compile SSG template', () =>
      compileSSGTemplate(params.ssgTemplateContent),
    ),
  ]);

  return {
    renderPathnames: (pathnames) => {
      return pMap<string, SSGResult>(
        pathnames,
        async (pathname) =>
          generateStaticFile({
            pathname,
            appRenderer,
            params,
            htmlMinifier,
            ssgTemplate,
          }),
        {concurrency: SSGConcurrency},
      );
    },
  };
}

// We reduce the page collected data structure after the HTML file is written
// Some data (modules, metadata.internal) is only useful to create the HTML file
// It's not useful to aggregate that collected data in memory
// Keep this data structure as small as possible
// See https://github.com/facebook/docusaurus/pull/11162
function reduceCollectedData(
  pageCollectedData: PageCollectedDataInternal,
): PageCollectedData {
  // We re-create the object from scratch
  // We absolutely want to avoid TS duck typing
  return {
    anchors: pageCollectedData.anchors,
    metadata: {
      public: pageCollectedData.metadata.public,
    },
    links: pageCollectedData.links,
  };
}

async function generateStaticFile({
  pathname,
  appRenderer,
  params,
  htmlMinifier,
  ssgTemplate,
}: {
  pathname: string;
  appRenderer: AppRenderer;
  params: SSGParams;
  htmlMinifier: HtmlMinifier;
  ssgTemplate: SSGTemplateCompiled;
}): Promise<SSGResult> {
  try {
    // This only renders the app HTML
    let t = performance.now();
    const appRenderResult = await appRenderer.render({pathname});
    SSGProfile.render += performance.now() - t;
    t = performance.now();
    // This renders the full page HTML, including head tags...
    const fullPageHtml = renderSSGTemplate({
      params,
      result: appRenderResult,
      ssgTemplate,
    });
    SSGProfile.template += performance.now() - t;
    t = performance.now();
    const minifierResult = await htmlMinifier.minify(fullPageHtml);
    SSGProfile.minify += performance.now() - t;
    t = performance.now();
    await writeStaticFile({
      pathname,
      content: minifierResult.code,
      params,
    });
    SSGProfile.write += performance.now() - t;

    const collectedData = reduceCollectedData(appRenderResult.collectedData);

    return {
      success: true,
      pathname,
      result: {
        collectedData,
        // As of today, only the html minifier can emit SSG warnings
        warnings: minifierResult.warnings,
      },
    };
  } catch (errorUnknown) {
    const error = errorUnknown as Error;
    const tips = getSSGErrorTips(error);
    const message = logger.interpolate`Can't render static file for pathname path=${pathname}${
      tips ? `\n\n${tips}` : ''
    }`;
    return {
      success: false,
      pathname,
      error: serializeError(new Error(message, {cause: error})),
    };
  }
}

function getSSGErrorTips(error: Error): string {
  const parts = [];

  const isNotDefinedErrorRegex =
    /(?:window|document|localStorage|navigator|alert|location|buffer|self) is not defined/i;
  if (isNotDefinedErrorRegex.test(error.message)) {
    parts.push(`It looks like you are using code that should run on the client-side only.
To get around it, try using one of:
- ${logger.code('<BrowserOnly>')} (${logger.url(
      'https://docusaurus.io/docs/docusaurus-core/#browseronly',
    )})
- ${logger.code('ExecutionEnvironment')} (${logger.url(
      'https://docusaurus.io/docs/docusaurus-core/#executionenvironment',
    )}).
It might also require to wrap your client code in ${logger.code(
      'useEffect',
    )} hook and/or import a third-party library dynamically (if any).`);
  }

  return parts.join('\n');
}

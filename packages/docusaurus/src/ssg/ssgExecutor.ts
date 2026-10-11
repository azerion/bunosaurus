/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as path from 'node:path';
import os from 'node:os';
import _ from 'lodash';
import logger, {PerfLogger} from '@docusaurus/logger';
import {createSSGParams} from './ssgParams';
import {renderHashRouterTemplate} from './ssgTemplate';
import {SSGWorkerThreadCount, SSGWorkerThreadTaskSize} from './ssgEnv';
import {generateHashRouterEntrypoint} from './ssgUtils';
import {createGlobalSSGResult} from './ssgGlobalResult';
import type {SSGGlobalResult} from './ssgGlobalResult';
import type {SSGParams} from './ssgParams';
import type {Props, RouterType} from '@docusaurus/types';
import type {SiteCollectedData} from '../common';
import type {SSGResult} from './ssgRenderer';
import type {
  SSGWorkerMessage,
  SSGWorkerResponse,
  SSGWorkerTask,
} from './ssgWorkerProcess';

type SSGExecutor = {
  run: () => Promise<SSGGlobalResult>;
  destroy: () => Promise<void>;
};

// Sensible default that gives decent performances
// It's hard to have a perfect formula that works for all hosts
// Each thread has some creation overhead
// Having 1 thread per cpu doesn't necessarily improve perf on small sites
// We want to ensure that we don't create a worker thread for less than x paths
function inferNumberOfThreads({
  pageCount,
  cpuCount,
  minPagesPerCpu,
}: {
  pageCount: number;
  cpuCount: number;
  minPagesPerCpu: number;
}) {
  // Calculate "ideal" amount of threads based on the number of pages to render
  const threadsByWorkload = Math.ceil(pageCount / minPagesPerCpu);
  // Use the smallest of threadsByWorkload or cpuCount, ensuring min=1 thread
  return Math.max(1, Math.min(threadsByWorkload, cpuCount));
}

function getNumberOfThreads(pathnames: string[]) {
  if (typeof SSGWorkerThreadCount !== 'undefined') {
    return SSGWorkerThreadCount;
  }

  // See also https://github.com/tinylibs/tinypool/pull/108
  const cpuCount = os.availableParallelism();

  return inferNumberOfThreads({
    pageCount: pathnames.length,
    cpuCount,
    // These are "magic value" that we should refine based on user feedback
    // Local tests show that it's not worth spawning new workers for few pages
    minPagesPerCpu: 100,
  });
}

// Workaround for Node styleText() limitation
// See https://github.com/nodejs/node/issues/65766
function getWorkerColorEnv(): Record<string, string> {
  // Preserve an explicit user choice
  if (process.env.FORCE_COLOR !== undefined) {
    return {};
  }

  const depth = process.stdout.isTTY
    ? (process.stdout.getColorDepth?.() ?? 0)
    : 0;
  if (depth > 2) {
    return {FORCE_COLOR: depth >= 24 ? '3' : depth >= 8 ? '2' : '1'};
  }

  return {};
}

// SSG always runs in worker processes, even for small sites
// This isolates the server bundle execution from the main Docusaurus process
// We use processes rather than threads: Bun worker threads don't scale here
async function createSSGExecutor({
  params,
  pathnames,
  locale,
}: {
  params: SSGParams;
  pathnames: string[];
  locale: string;
}): Promise<SSGExecutor> {
  const numberOfWorkers = getNumberOfThreads(pathnames);
  const tasks: SSGWorkerTask[] = _.chunk(
    pathnames,
    SSGWorkerThreadTaskSize,
  ).map((taskPathnames, index) => ({id: index + 1, pathnames: taskPathnames}));

  let nextTaskIndex = 0;
  const results: SSGResult[][] = [];
  let remainingTasks = tasks.length;
  const {promise: allDone, resolve, reject} = Promise.withResolvers<void>();
  if (remainingTasks === 0) {
    resolve();
  }

  function sendNextTask(worker: Bun.Subprocess) {
    const task = tasks[nextTaskIndex];
    if (task) {
      nextTaskIndex += 1;
      const message: SSGWorkerMessage = {type: 'task', task};
      worker.send(message);
    }
  }

  const workerPath = path.resolve(__dirname, 'ssgWorkerProcess.js');
  const workers = await PerfLogger.async(
    `Create SSG worker processes - ${logger.cyan(numberOfWorkers)} workers`,
    async () =>
      Array.from({length: numberOfWorkers}, (_unused, index) => {
        const worker = Bun.spawn({
          cmd: [process.execPath, workerPath],
          env: {
            ...process.env,
            ...getWorkerColorEnv(),
            // Locales can be built concurrently: don't rely on process.env
            DOCUSAURUS_CURRENT_LOCALE: locale,
          },
          stdio: ['ignore', 'inherit', 'inherit'],
          ipc(message: SSGWorkerResponse, subprocess) {
            results[message.id - 1] = message.results;
            // Note, we don't use PerfLogger.async() because all tasks are
            // submitted at once, while results are received progressively
            PerfLogger.log(`Result for task ${logger.name(message.id)}`);
            remainingTasks -= 1;
            if (remainingTasks === 0) {
              resolve();
            } else {
              sendNextTask(subprocess);
            }
          },
          onExit(_subprocess, exitCode) {
            if (remainingTasks > 0 && exitCode !== 0) {
              reject(
                new Error(
                  `SSG worker process ${index + 1} exited unexpectedly with code ${exitCode}`,
                ),
              );
            }
          },
        });
        const initMessage: SSGWorkerMessage = {
          type: 'init',
          workerId: index + 1,
          params,
        };
        worker.send(initMessage);
        return worker;
      }),
  );

  return {
    run: async () => {
      await PerfLogger.async(`Worker pool`, async () => {
        // Each worker processes one task at a time
        if (process.env.DOCUSAURUS_SSG_PROFILE === 'true') {
          console.log(`SSG pool start at=${Date.now() % 100000}`);
        }
        workers.forEach((worker) => sendNextTask(worker));
        await allDone;
      });
      return createGlobalSSGResult(results.flat());
    },

    destroy: async () => {
      workers.forEach((worker) => worker.kill());
    },
  };
}

export async function executeSSG({
  props,
  serverBundlePath,
  clientManifestPath,
  router,
}: {
  props: Props;
  serverBundlePath: string;
  clientManifestPath: string;
  router: RouterType;
}): Promise<{collectedData: SiteCollectedData}> {
  const params = await createSSGParams({
    serverBundlePath,
    clientManifestPath,
    props,
  });

  // TODO doesn't look like the appropriate place for hash router entry
  if (router === 'hash') {
    PerfLogger.start('Generate Hash Router entry point');
    const content = await renderHashRouterTemplate({params});
    await generateHashRouterEntrypoint({content, params});
    PerfLogger.end('Generate Hash Router entry point');
    return {collectedData: {}};
  }

  const executor = await createSSGExecutor({
    params,
    pathnames: props.routesPaths,
    locale: props.i18n.currentLocale,
  });
  const result = await executor.run();
  await executor.destroy();
  return result;
}

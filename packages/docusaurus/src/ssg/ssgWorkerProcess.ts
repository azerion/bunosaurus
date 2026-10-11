/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import logger, {PerfLogger} from '@docusaurus/logger';
import {
  loadSSGRenderer,
  SSGProfile,
  type SSGRenderer,
  type SSGResult,
} from './ssgRenderer';
import type {SSGParams} from './ssgParams';

// SSG runs in child processes rather than worker threads: Bun worker threads
// of the same process don't scale for this CPU-bound work (shared heap/GC).

export type SSGWorkerTask = {
  id: number;
  pathnames: string[];
};

export type SSGWorkerMessage =
  | {type: 'init'; workerId: number; params: SSGParams}
  | {type: 'task'; task: SSGWorkerTask};

export type SSGWorkerResponse = {
  type: 'result';
  id: number;
  results: SSGResult[];
};

// Web Storage should not be available during SSG
Reflect.deleteProperty(globalThis, 'localStorage');
Reflect.deleteProperty(globalThis, 'sessionStorage');

let workerPrefix = 'SSG Worker';
let rendererPromise: Promise<SSGRenderer> | undefined;

async function handleTask(task: SSGWorkerTask) {
  if (!rendererPromise) {
    throw new Error('SSG worker process received a task before init');
  }
  const renderer = await rendererPromise;
  const results = await PerfLogger.async(
    `${workerPrefix} - Task ${logger.name(task.id)} - Rendering ${logger.cyan(
      task.pathnames.length,
    )} pathnames`,
    () => renderer.renderPathnames(task.pathnames),
  );
  if (process.env.DOCUSAURUS_SSG_PROFILE === 'true') {
    console.log(
      `${workerPrefix} - Task ${task.id} - profile at=${Date.now() % 100000}`,
      JSON.stringify(SSGProfile, (_key, value: unknown) =>
        typeof value === 'number' ? Math.round(value) : value,
      ),
    );
  }
  const response: SSGWorkerResponse = {type: 'result', id: task.id, results};
  process.send!(response);
}

process.on('message', (message: SSGWorkerMessage) => {
  if (message.type === 'init') {
    if (process.env.DOCUSAURUS_SSG_PROFILE === 'true') {
      console.log(
        `SSG Worker ${message.workerId} init at=${Date.now() % 100000}`,
      );
    }
    workerPrefix = `SSG Worker ${logger.name(message.workerId)}`;
    // We only load the SSG renderer once (expensive), not once per task
    rendererPromise = PerfLogger.async(`${workerPrefix} - Initialization`, () =>
      loadSSGRenderer({params: message.params}),
    );
  } else if (message.type === 'task') {
    handleTask(message.task).catch((error) => {
      logger.error(error);
      process.exit(1);
    });
  }
});

/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import logger from '@docusaurus/logger';
import browserslist from 'browserslist';
import {browserslistToTargets, transform} from 'lightningcss';
import {getBrowserslistQueries} from '../browserslist';
import type {BuildConfig, BuildOutput} from 'bun';

function formatLog(log: BuildOutput['logs'][number]): string {
  const position = log.position
    ? `\n  at ${log.position.file}:${log.position.line}:${log.position.column}`
    : '';
  return `${log.message}${position}`;
}

/**
 * Runs Bun.build() and turns build errors into a readable Docusaurus error
 */
export async function bunBuild(
  name: string,
  config: BuildConfig,
): Promise<BuildOutput> {
  let output: BuildOutput;
  try {
    output = await Bun.build({...config, throw: false});
  } catch (error) {
    // Bun throws an AggregateError when throw: true, keep the logic robust
    const errors = (error as AggregateError).errors ?? [error];
    throw new Error(
      `${name} bundle compiled with errors therefore further build is impossible.\n${errors
        .map((e: unknown) => String((e as Error).message ?? e))
        .join('\n\n')}`,
      {cause: error},
    );
  }
  const warnings = output.logs.filter((log) => log.level === 'warning');
  if (warnings.length > 0) {
    logger.warn(
      `${name} bundle compiled with warnings:\n${warnings.map(formatLog).join('\n\n')}`,
    );
  }
  if (!output.success) {
    const errors = output.logs.filter((log) => log.level === 'error');
    throw new Error(
      `${name} bundle compiled with errors therefore further build is impossible.\n${errors
        .map(formatLog)
        .join('\n\n')}`,
    );
  }
  return output;
}

let cssTargets: ReturnType<typeof browserslistToTargets> | undefined;

/**
 * Bun bundles CSS but doesn't apply vendor prefixes for a Browserslist query.
 * We run a final LightningCSS pass on the single CSS output file.
 */
export function transformFinalCss({
  code,
  filename,
  minify,
}: {
  code: Uint8Array;
  filename: string;
  minify: boolean;
}): Uint8Array {
  cssTargets ??= browserslistToTargets(browserslist(getBrowserslistQueries()));
  const result = transform({
    filename,
    code,
    minify,
    targets: cssTargets,
    // Docusaurus sites can contain CSS that LightningCSS doesn't understand
    errorRecovery: true,
  });
  return result.code;
}

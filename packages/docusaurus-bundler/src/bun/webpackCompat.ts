/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import logger from '@docusaurus/logger';
import {matchCondition, type Condition} from './conditions';
import type {LoaderItem} from './loaderRunner';

// Minimal subset of the Webpack config types that we interpret
type RuleSetUseItem =
  | string
  | ((...args: never[]) => unknown)
  | {loader?: string; options?: unknown};

type RuleSetRule = {
  test?: unknown;
  include?: unknown;
  exclude?: unknown;
  issuer?: unknown;
  resourceQuery?: unknown;
  oneOf?: (RuleSetRule | Falsy)[];
  rules?: (RuleSetRule | Falsy)[];
  use?: RuleSetUseItem | RuleSetUseItem[];
  loader?: string;
  options?: unknown;
};

type Falsy = false | null | undefined | 0 | '' | '...';

export type WebpackConfigLike = {
  resolve?: {alias?: unknown};
  module?: {rules?: unknown[]};
  plugins?: unknown[];
};

/**
 * Docusaurus plugins (including third-party ones) still describe their bundler
 * needs with the historical configureWebpack() lifecycle.
 * Instead of rewriting every plugin, the Bun bundler interprets the subset of
 * the Webpack config that matters for Docusaurus sites:
 * - resolve.alias
 * - module.rules (loaders are executed by our own minimal loader runner)
 * - DefinePlugin
 * - ContextReplacementPlugin (used by the classic theme for Prism languages)
 * Everything else is ignored with a warning.
 */

// Recorded instances of the Webpack plugins that the shim below exposes
class ShimPlugin {
  readonly pluginName: string;
  readonly args: unknown[];

  constructor(pluginName: string, args: unknown[]) {
    this.pluginName = pluginName;
    this.args = args;
  }
  // Webpack plugins have an apply() method: make sure nobody calls it
  apply(): void {
    throw new Error(
      `The Webpack plugin ${this.pluginName} can't be applied with the Docusaurus Bun bundler`,
    );
  }
}

function shimPluginClass(pluginName: string) {
  return class extends ShimPlugin {
    constructor(...args: unknown[]) {
      super(pluginName, args);
    }
  };
}

/**
 * A fake "webpack" namespace exposed to plugins as `currentBundler.instance`
 */
export const BundlerInstanceShim = {
  DefinePlugin: shimPluginClass('DefinePlugin'),
  EnvironmentPlugin: shimPluginClass('EnvironmentPlugin'),
  ContextReplacementPlugin: shimPluginClass('ContextReplacementPlugin'),
  ProvidePlugin: shimPluginClass('ProvidePlugin'),
  IgnorePlugin: shimPluginClass('IgnorePlugin'),
  NormalModuleReplacementPlugin: shimPluginClass(
    'NormalModuleReplacementPlugin',
  ),
  ProgressPlugin: shimPluginClass('ProgressPlugin'),
  CopyRspackPlugin: shimPluginClass('CopyRspackPlugin'),
  CssExtractRspackPlugin: shimPluginClass('CssExtractRspackPlugin'),
};

export type CompatRule = {
  test?: Condition;
  include?: Condition;
  exclude?: Condition;
  issuer?: Condition;
  resourceQuery?: Condition;
  oneOf?: CompatRule[];
  rules?: CompatRule[];
  use: LoaderItem[];
};

export type ContextReplacement = {
  resourceRegExp: RegExp;
  newContentRegExp: RegExp;
};

export type BundlerContributions = {
  aliases: {[alias: string]: string};
  rules: CompatRule[];
  define: {[key: string]: string};
  contextReplacements: ContextReplacement[];
};

// Assets loaders are handled natively by the Docusaurus asset pipeline
// Bare names (Docusaurus core rules) or resolved paths (third-party rules)
const AssetLoaderRegExp = /(?:^|[\\/])(?:file|url)-loader(?:[\\/]|$)/;

export function isAssetLoader(loader: string): boolean {
  return AssetLoaderRegExp.test(loader);
}

function normalizeUseItem(item: RuleSetUseItem): LoaderItem | null {
  if (typeof item === 'string') {
    return {loader: item};
  }
  if (typeof item === 'function') {
    logger.warn`Function loaders in module.rules are not supported by the Docusaurus Bun bundler and will be ignored.`;
    return null;
  }
  if (item && typeof item === 'object' && typeof item.loader === 'string') {
    return {loader: item.loader, options: item.options};
  }
  return null;
}

function normalizeUse(rule: RuleSetRule): LoaderItem[] {
  const use =
    rule.use ??
    (rule.loader ? [{loader: rule.loader, options: rule.options}] : []);
  const items = (Array.isArray(use) ? use : [use]) as RuleSetUseItem[];
  return items
    .map(normalizeUseItem)
    .filter((item): item is LoaderItem => item !== null);
}

function normalizeRule(rule: RuleSetRule | Falsy): CompatRule | null {
  if (!rule || rule === '...') {
    return null;
  }
  const normalized: CompatRule = {
    test: rule.test as Condition | undefined,
    include: rule.include as Condition | undefined,
    exclude: rule.exclude as Condition | undefined,
    issuer: rule.issuer as Condition | undefined,
    resourceQuery: rule.resourceQuery as Condition | undefined,
    use: normalizeUse(rule),
  };
  if (rule.oneOf) {
    normalized.oneOf = rule.oneOf
      .map((r) => normalizeRule(r))
      .filter((r): r is CompatRule => r !== null);
  }
  if (rule.rules) {
    normalized.rules = rule.rules
      .map((r) => normalizeRule(r))
      .filter((r): r is CompatRule => r !== null);
  }
  return normalized;
}

export function interpretWebpackConfig(
  config: WebpackConfigLike,
): BundlerContributions {
  const aliases: BundlerContributions['aliases'] = {};
  const alias = config.resolve?.alias;
  if (alias && typeof alias === 'object' && !Array.isArray(alias)) {
    Object.entries(alias as {[key: string]: unknown}).forEach(
      ([key, value]) => {
        if (typeof value === 'string') {
          aliases[key] = value;
        } else if (Array.isArray(value) && typeof value[0] === 'string') {
          aliases[key] = value[0];
        }
      },
    );
  }

  const rules = (config.module?.rules ?? [])
    .map((r) => normalizeRule(r as RuleSetRule))
    .filter((r): r is CompatRule => r !== null);

  const define: BundlerContributions['define'] = {};
  const contextReplacements: ContextReplacement[] = [];
  (config.plugins ?? []).forEach((plugin) => {
    if (!plugin) {
      return;
    }
    if (plugin instanceof ShimPlugin) {
      if (plugin.pluginName === 'DefinePlugin') {
        const definitions = plugin.args[0] as {[key: string]: unknown};
        Object.entries(definitions).forEach(([key, value]) => {
          define[key] =
            typeof value === 'string' ? value : JSON.stringify(value);
        });
        return;
      }
      if (plugin.pluginName === 'EnvironmentPlugin') {
        // Either a list of env variable names or an object of default values
        const arg = plugin.args[0] as string[] | {[key: string]: unknown};
        const entries: [string, unknown][] = Array.isArray(arg)
          ? arg.map((key) => [key, undefined])
          : Object.entries(arg);
        entries.forEach(([key, defaultValue]) => {
          const value = process.env[key] ?? defaultValue;
          define[`process.env.${key}`] =
            value === undefined ? 'undefined' : JSON.stringify(value);
        });
        return;
      }
      if (plugin.pluginName === 'ContextReplacementPlugin') {
        const [resourceRegExp, newContentRegExp] = plugin.args;
        if (
          resourceRegExp instanceof RegExp &&
          newContentRegExp instanceof RegExp
        ) {
          contextReplacements.push({resourceRegExp, newContentRegExp});
          return;
        }
      }
      logger.warn`Webpack plugin name=${plugin.pluginName} is not supported by the Docusaurus Bun bundler and will be ignored.`;
      return;
    }
    const name = (plugin as object).constructor?.name ?? 'unknown';
    logger.warn`Webpack plugin name=${name} is not supported by the Docusaurus Bun bundler and will be ignored.`;
  });

  return {aliases, rules, define, contextReplacements};
}

/**
 * Resolves the loaders to apply to a given module, following the Webpack rule
 * matching semantics (all matching rules apply, oneOf picks the first match).
 * Returns null when no custom loader applies (asset loaders are excluded).
 */
export function resolveRuleLoaders({
  rules,
  resourcePath,
  resourceQuery,
  issuer,
}: {
  rules: CompatRule[];
  resourcePath: string;
  resourceQuery: string;
  issuer: string;
}): LoaderItem[] {
  const loaders: LoaderItem[] = [];

  function matches(rule: CompatRule): boolean {
    return (
      (rule.test === undefined || matchCondition(rule.test, resourcePath)) &&
      (rule.include === undefined ||
        matchCondition(rule.include, resourcePath)) &&
      (rule.exclude === undefined ||
        !matchCondition(rule.exclude, resourcePath)) &&
      (rule.issuer === undefined || matchCondition(rule.issuer, issuer)) &&
      (rule.resourceQuery === undefined ||
        matchCondition(rule.resourceQuery, resourceQuery))
    );
  }

  function visit(rule: CompatRule) {
    if (!matches(rule)) {
      return;
    }
    loaders.push(...rule.use);
    if (rule.rules) {
      rule.rules.forEach(visit);
    }
    if (rule.oneOf) {
      const match = rule.oneOf.find(matches);
      if (match) {
        visit(match);
      }
    }
  }

  rules.forEach(visit);
  return loaders.filter((l) => !isAssetLoader(l.loader));
}

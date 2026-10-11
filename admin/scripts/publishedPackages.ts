/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Names under which the monorepo packages are published, see release.ts

export type PackageJson = {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: {[name: string]: string};
  devDependencies?: {[name: string]: string};
  peerDependencies?: {[name: string]: string};
  optionalDependencies?: {[name: string]: string};
};

const PublishScope = '@azerion';
const PublishPrefix = 'bunosaurus';

// Repo-internal linting tools, unchanged from upstream: not published
export const UnpublishedPackages = new Set([
  '@docusaurus/eslint-plugin',
  'stylelint-copyright',
]);

/**
 * "@docusaurus/core" => "@azerion/bunosaurus-core"
 * "create-docusaurus" => "@azerion/create-bunosaurus"
 */
export function getPublishedName(name: string): string {
  if (name === 'create-docusaurus') {
    return `${PublishScope}/create-${PublishPrefix}`;
  }
  const match = name.match(/^@docusaurus\/(.+)$/);
  if (!match) {
    throw new Error(`No published name for package ${name}`);
  }
  return `${PublishScope}/${PublishPrefix}-${match[1]}`;
}

/**
 * Renames a package.json for publishing, and replaces its dependencies on
 * other published packages with npm aliases
 */
export function toPublishedPackageJson(
  pkg: PackageJson,
  publishedNames: ReadonlySet<string>,
): PackageJson {
  const result: PackageJson = {...pkg};
  if (publishedNames.has(pkg.name)) {
    result.name = getPublishedName(pkg.name);
  }
  (
    [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ] as const
  ).forEach((field) => {
    const deps = pkg[field];
    if (!deps) {
      return;
    }
    result[field] = Object.fromEntries(
      Object.entries(deps).map(([name, range]) => {
        if (!publishedNames.has(name)) {
          return [name, range];
        }
        if (range.startsWith('workspace:')) {
          throw new Error(
            `Unresolved ${range} range for ${name} in ${pkg.name}`,
          );
        }
        return [name, `npm:${getPublishedName(name)}@${range}`];
      }),
    );
  });
  return result;
}

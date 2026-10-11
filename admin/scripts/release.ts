/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Versions and publishes the monorepo packages (replaces "lerna version" and
// "lerna publish", all packages share the same version).
//
// Packages are published under other names than the @docusaurus/* names used
// in this repo (see getPublishedName), and depend on each other with npm
// aliases: "@docusaurus/utils": "npm:@azerion/bunosaurus-utils@<version>".
// They are still installed under their @docusaurus/* names, which the code
// relies on (presets, plugin shorthands, theme imports, swizzled components),
// so Bunosaurus is a drop-in replacement: sites only change their package.json
// "@docusaurus/core": "npm:@azerion/bunosaurus-core@<version>"
//
// Usage:
//   bun admin/scripts/release.ts version <version>
//     Sets the version of all the workspace packages, and of the exact
//     internal dependencies (templates use "@docusaurus/core": "<version>"),
//     and updates bun.lock
//   bun admin/scripts/release.ts canary-version
//     Prints the canary version: <core version>-canary-<commits>+<sha>
//   bun admin/scripts/release.ts pack <dir>
//     Packs the public packages with their published names in <dir>
//   bun admin/scripts/release.ts publish --tag <tag> [--registry <url>]
//     [--client bun|npm] [--dry-run]
//     Packs the public packages and publishes the tarballs. Use the npm
//     client for npm trusted publishing (OIDC), unsupported by "bun publish".

import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fs} from '@docusaurus/fs';
import {$} from 'bun';
import {
  getPublishedName,
  toPublishedPackageJson,
  UnpublishedPackages,
  type PackageJson,
} from './publishedPackages';

const rootDir = path.resolve(import.meta.dir, '../..');

async function getWorkspacePackageJsonPaths(): Promise<string[]> {
  const rootPkg = (await Bun.file(
    path.join(rootDir, 'package.json'),
  ).json()) as {
    workspaces: string[];
  };
  const paths: string[] = [];
  for (const pattern of rootPkg.workspaces) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for await (const pkgJsonPath of glob.scan({cwd: rootDir})) {
      if (!pkgJsonPath.includes('node_modules')) {
        paths.push(path.join(rootDir, pkgJsonPath));
      }
    }
  }
  return paths.sort();
}

async function readPackageJson(pkgJsonPath: string): Promise<PackageJson> {
  return (await Bun.file(pkgJsonPath).json()) as PackageJson;
}

async function getCoreVersion(): Promise<string> {
  const pkg = await readPackageJson(
    path.join(rootDir, 'packages/docusaurus/package.json'),
  );
  return pkg.version;
}

async function setVersion(newVersion: string): Promise<void> {
  const oldVersion = await getCoreVersion();
  const pkgJsonPaths = await getWorkspacePackageJsonPaths();
  const pkgs = await Promise.all(pkgJsonPaths.map(readPackageJson));
  const workspaceNames = new Set(pkgs.map((pkg) => pkg.name));
  await Promise.all(
    pkgJsonPaths.map(async (pkgJsonPath, index) => {
      const pkg = pkgs[index]!;
      // Benchmark sites and other non-versioned workspaces keep their version
      if (pkg.version !== oldVersion) {
        return;
      }
      // Edit the text to preserve the formatting of package.json files
      let text = await Bun.file(pkgJsonPath).text();
      text = text.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${newVersion}$2`);
      for (const name of workspaceNames) {
        const escapedName = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        text = text.replace(
          new RegExp(`("${escapedName}":\\s*")${oldVersion}(")`, 'g'),
          `$1${newVersion}$2`,
        );
      }
      await Bun.write(pkgJsonPath, text);
    }),
  );
  // "bun pm pack" replaces workspace:* ranges with the versions of bun.lock
  await $`bun install --lockfile-only --ignore-scripts`.cwd(rootDir).quiet();
  console.log(`Version ${oldVersion} => ${newVersion}`);
}

async function getCanaryVersion(): Promise<string> {
  const coreVersion = (await getCoreVersion()).split('-')[0];
  const commitCount = (
    await $`git rev-list --count HEAD`.cwd(rootDir).text()
  ).trim();
  const sha = (await $`git rev-parse --short HEAD`.cwd(rootDir).text()).trim();
  return `${coreVersion}-canary-${commitCount}+${sha}`;
}

async function getPublishedPackages(): Promise<
  {pkg: PackageJson; pkgDir: string}[]
> {
  const pkgJsonPaths = (await getWorkspacePackageJsonPaths()).filter(
    (pkgJsonPath) =>
      path.relative(rootDir, pkgJsonPath).split(path.sep).length === 3 &&
      pkgJsonPath.startsWith(path.join(rootDir, 'packages')),
  );
  const packages = await Promise.all(
    pkgJsonPaths.map(async (pkgJsonPath) => ({
      pkg: await readPackageJson(pkgJsonPath),
      pkgDir: path.dirname(pkgJsonPath),
    })),
  );
  return packages.filter(
    ({pkg}) => !pkg.private && !UnpublishedPackages.has(pkg.name),
  );
}

async function rewritePackageJsonFile(
  pkgJsonPath: string,
  publishedNames: ReadonlySet<string>,
): Promise<void> {
  const pkg = await readPackageJson(pkgJsonPath);
  await Bun.write(
    pkgJsonPath,
    `${JSON.stringify(toPublishedPackageJson(pkg, publishedNames), null, 2)}\n`,
  );
}

/**
 * Packs the publishable packages with "bun pm pack" (it replaces workspace:*
 * ranges by actual versions), then renames them inside the tarballs
 */
async function packPackages(
  destination: string,
): Promise<
  {tarballPath: string; name: string; version: string; pkgDir: string}[]
> {
  await fs.mkdir(destination, {recursive: true});
  const packages = await getPublishedPackages();
  const publishedNames = new Set(packages.map(({pkg}) => pkg.name));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docusaurus-pack-'));
  try {
    return await Promise.all(
      packages.map(async ({pkg, pkgDir}) => {
        const packDir = await fs.mkdtemp(path.join(workDir, 'package-'));
        const tarball = (
          await $`bun pm pack --quiet --destination ${packDir}`
            .cwd(pkgDir)
            .text()
        )
          .trim()
          .split('\n')
          .at(-1)!;
        await $`tar -xzf ${path.basename(tarball)}`.cwd(packDir);
        await rewritePackageJsonFile(
          path.join(packDir, 'package', 'package.json'),
          publishedNames,
        );
        // Sites created from templates install the published packages too
        for await (const templatePkgJson of new Bun.Glob(
          'package/templates/*/package.json',
        ).scan({cwd: packDir})) {
          await rewritePackageJsonFile(
            path.join(packDir, templatePkgJson),
            publishedNames,
          );
        }
        const name = getPublishedName(pkg.name);
        const tarballPath = path.join(
          destination,
          `${name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`,
        );
        await $`tar -czf ${tarballPath} package`.cwd(packDir);
        return {tarballPath, name, version: pkg.version, pkgDir};
      }),
    );
  } finally {
    await fs.rm(workDir, {recursive: true, force: true});
  }
}

async function publish(options: {
  tag: string;
  registry: string | undefined;
  client: 'bun' | 'npm';
  dryRun: boolean;
}): Promise<void> {
  const packDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'docusaurus-publish-'),
  );
  const tarballs = await packPackages(packDir);
  const registryArgs = options.registry
    ? [`--registry=${options.registry}`]
    : [];
  const dryRunArgs = options.dryRun ? ['--dry-run'] : [];
  for (const {tarballPath, name, version, pkgDir} of tarballs) {
    console.log(`Publishing ${name}@${version} (${options.tag})`);
    if (options.client === 'npm') {
      await $`npm publish ${tarballPath} --tag ${options.tag} --access public ${registryArgs} ${dryRunArgs}`;
    } else {
      // Bun needs a token, even for registries that don't check it (Verdaccio)
      // The published metadata comes from the tarball, but Bun requires a
      // package.json in the cwd
      await $`bun publish ${tarballPath} --tag ${options.tag} --access public ${registryArgs} ${dryRunArgs}`.cwd(
        pkgDir,
      );
    }
  }
}

const {positionals, values} = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    tag: {type: 'string'},
    registry: {type: 'string'},
    client: {type: 'string', default: 'bun'},
    'dry-run': {type: 'boolean', default: false},
  },
});

const [command, arg] = positionals;
if (command === 'version' && arg) {
  await setVersion(arg);
} else if (command === 'canary-version') {
  console.log(await getCanaryVersion());
} else if (command === 'pack' && arg) {
  const tarballs = await packPackages(path.resolve(arg));
  tarballs.forEach(({tarballPath}) => console.log(tarballPath));
} else if (command === 'publish' && values.tag) {
  if (values.client !== 'bun' && values.client !== 'npm') {
    throw new Error(`Unknown client "${values.client}", use bun or npm`);
  }
  await publish({
    tag: values.tag,
    registry: values.registry,
    client: values.client,
    dryRun: values['dry-run'],
  });
} else {
  console.error(
    'Usage: bun admin/scripts/release.ts version <version> | canary-version | pack <dir> | publish --tag <tag> [--registry <url>] [--client bun|npm] [--dry-run]',
  );
  process.exit(1);
}

/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Packs all the public monorepo packages as tarballs, to use them in a site
// outside of this monorepo, and prints the package.json "overrides" to add.
// When a site directory is given, the overrides are written to its
// package.json instead.
//
// Usage: bun admin/scripts/packForSite.ts <destinationDir> [siteDir]
// Run "bun run build:packages" first.

import path from 'node:path';
import {$} from 'bun';

const destination = path.resolve(process.argv[2] ?? 'dist-packages');
const siteDir = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const rootDir = path.resolve(import.meta.dir, '../..');

const overrides: {[name: string]: string} = {};
const glob = new Bun.Glob('packages/*/package.json');
for await (const pkgJsonPath of glob.scan({cwd: rootDir})) {
  const pkgDir = path.join(rootDir, path.dirname(pkgJsonPath));
  const pkg = (await Bun.file(path.join(pkgDir, 'package.json')).json()) as {
    name: string;
    version: string;
    private?: boolean;
  };
  if (pkg.private) {
    continue;
  }
  await $`bun pm pack --quiet --destination ${destination}`.cwd(pkgDir).quiet();
  const tarball = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${
    pkg.version
  }.tgz`;
  overrides[pkg.name] = `file:${path.join(destination, tarball)}`;
}

if (siteDir) {
  const sitePkgPath = path.join(siteDir, 'package.json');
  const sitePkg = (await Bun.file(sitePkgPath).json()) as {
    overrides?: {[name: string]: string};
  };
  sitePkg.overrides = {...sitePkg.overrides, ...overrides};
  await Bun.write(sitePkgPath, `${JSON.stringify(sitePkg, null, 2)}\n`);
  console.log(
    `Added ${Object.keys(overrides).length} overrides to ${sitePkgPath}`,
  );
} else {
  console.log(JSON.stringify({overrides}, null, 2));
}

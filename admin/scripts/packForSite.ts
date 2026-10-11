/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Packs all the public monorepo packages as tarballs, to use them in a site
// outside of this monorepo, and prints the package.json "overrides" to add.
//
// Usage: bun admin/scripts/packForSite.ts <destinationDir>
// Run "bun run build:packages" first.

import path from 'node:path';
import {$} from 'bun';

const destination = path.resolve(process.argv[2] ?? 'dist-packages');
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

console.log(JSON.stringify({overrides}, null, 2));

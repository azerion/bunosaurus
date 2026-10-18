---
name: upstream-sync
description: Back-merge upstream Docusaurus (facebook/docusaurus main) into Bunosaurus, keeping upstream's functional changes while keeping the fork Bun-only (Bun workspaces and runtime, Bun.build bundler, no Node.js/pnpm/Lerna/Webpack/Rspack). Use when asked to sync, back-merge, pull in, or catch up with upstream / origin Docusaurus.
---

# Upstream sync

Bunosaurus is a fork of `facebook/docusaurus` (see `BUNOSAURUS.md`). Upstream keeps targeting Node.js, pnpm and Webpack/Rspack; the fork replaced all of these with Bun. A sync takes **every functional change** from upstream (features, fixes, breaking changes, docs, theme, MDX, plugins) and **translates or drops its toolchain changes**.

## 1. Prepare

```bash
git status                                  # must be clean
git remote get-url upstream || git remote add upstream https://github.com/facebook/docusaurus.git
git fetch upstream main
git switch -c chore/upstream-sync-$(date +%F)   # from the current integration branch
```

## 2. Triage before merging

```bash
git log --format="%h %s" --no-merges HEAD..upstream/main                        # what's coming
git merge-tree --write-tree --name-only HEAD upstream/main | tail -n +2   # files that will conflict
```

Go through each upstream commit and put it in one of these buckets. Write the list down, because you need it in step 4 and in the commit message:

| Bucket | Examples | What to do |
| --- | --- | --- |
| Functional | `feat`/`fix`/`break` in plugins, themes, mdx-loader, utils, core (not bundler) | Keep as is |
| Bundler-dependent | changes in `packages/docusaurus/src/webpack/`, `docusaurus-bundler` Webpack/Rspack/SWC parts, `@docusaurus/faster`, new `configureWebpack()` rules in plugins, output naming/hashing, asset handling | Keep the behavior and port it to the Bun bundler (step 4) |
| Toolchain | pnpm, Lerna, Node version, `.nvmrc`, npm publishing, pnpm/Node CI steps, Rspack/Webpack/SWC dependency bumps | Translate to Bun, or drop |
| Removed in fork | `plugin-rsdoctor`, `@docusaurus/faster`, `siteConfig.webpack` | Drop |

## 3. Merge

Merge, don't rebase or cherry-pick: a merge commit keeps the merge-base current, so the next sync only brings in new commits.

```bash
git merge --no-ff --no-commit upstream/main
```

Resolve conflicts with these rules:

- **`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `lerna.json`, `.nvmrc`**: keep them deleted (`git rm`). Never hand-merge `bun.lock`. Regenerate it with `bun install` once `package.json` files are resolved.
- **Root `package.json` scripts**: keep the fork's `bun run` / `bun run --filter <pkg>` form. Translate new upstream scripts: `pnpm --filter X Y` → `bun run --filter X Y`, `pnpm exec`/`npx` → `bunx` or the bin directly, `node file.js` → `bun file.js`. Keep `workspaces`, `patchedDependencies` and `overrides` from the fork.
- **`engines`**: keep `"bun": ">=…"`, never add `node` back.
- **Dependencies**: take upstream version bumps of shared deps. Don't add Webpack/Rspack/SWC/loader deps (`@rspack/core`, `webpack`, `*-webpack-plugin`, `@swc/core`, `file-loader`...) unless something that still exists in the fork imports them.
- **`.github/workflows/*`**: keep the fork's Bun steps (`oven-sh/setup-bun`, `bun install --frozen-lockfile`, `bun run …`). Port upstream's non-tooling changes, such as new jobs, permission or security hardening, and new checks, translated to Bun. Drop pnpm setup/cache changes and Lerna/pnpm publishing (the fork publishes with `admin/scripts/release.ts`).
- **Files the fork deleted** (`packages/docusaurus/src/webpack/**`, `docusaurus-bundler/src/{swc,minification}.ts`, rsdoctor, faster): keep them deleted with `git rm`, but first read the upstream diff (`git log -p HEAD...upstream/main -- <path>`) and port what it changes for sites (step 4).
- **Files both sides changed** (`docusaurus-utils/src/webpackUtils.ts`, `docusaurus-bundler/package.json`, `browserslist.ts`...): keep the fork's Bun implementation and apply upstream's API and behavior changes on top. Callers in upstream code may now expect the new signatures.
- **Tests**: new upstream tests declaring `@vitest-environment jsdom` must use `happy-dom`. Don't hand-merge snapshot files: take either side, then regenerate (`bun run test <file> -u`) and review the diff.
- **`AGENTS.md`, `.agents/skills/*`, `website/docs`, `README.md`**: take upstream's rule and wording changes, but keep commands Bun (`bun run …`, never `pnpm …`). Fork-only files (`BUNOSAURUS.md`, this skill, `admin/scripts/{release,packForSite,publishedPackages}.ts`, `admin/bench/`) are never touched by upstream. Keep them.
- **`packages/create-docusaurus/templates/`**: keep the fork's Bun defaults and take upstream's template content changes. Never edit `examples/` by hand.

After resolving, look for Node and pnpm leftovers that merged without a conflict:

```bash
git diff HEAD --name-only | xargs grep -n -E '\bpnpm\b|\bnpx\b|\blerna\b|"node":|jsdom|@rspack|rsdoctor' 2>/dev/null
```

## 4. Port bundler-dependent changes

The Bun bundler interprets a subset of the Webpack config (`packages/docusaurus-bundler/src/bun/webpackCompat.ts`, loaders through `loaderRunner.ts`, assets in `assets.ts`, client manifest in `packages/docusaurus/src/bundler/manifest.ts`). For each commit in the "bundler-dependent" bucket:

1. Work out what the change does for a site: output, URLs, supported syntax, config options.
2. Reproduce that behavior in the Bun bundler, or in `webpackCompat.ts` when a plugin's `configureWebpack()` now emits a new rule shape (e.g. `type: 'asset/resource'` instead of `file-loader`). Unsupported Webpack options are ignored _with a warning_. Look for those warnings in the build output.
3. Add or adapt a test in `packages/docusaurus-bundler/src/bun/__tests__` or `packages/docusaurus/src/bundler/__tests__`.
4. If the behavior can't or shouldn't be ported, write it down under "Breaking changes" or as a known gap in `BUNOSAURUS.md`.

Before relying on a Bun behavior, check the Bun docs and confirm it with a minimal repro.

## 5. Verify

```bash
bun install                      # regenerates bun.lock and builds the packages
bun run build:packages
bun run test
bun run lint                     # includes knip: unused Webpack-only deps/exports show up here
bun run --filter website typecheck
bun run build:website:fast
```

When a test fails, run only that file until it passes, then run the full suite again. If upstream upgraded Vitest, recreate `patches/vitest@<version>.patch` for the new version (inline snapshot frames on JavaScriptCore) and update `patchedDependencies`.

For bundler-dependent changes, also build a real site: `bun admin/scripts/packForSite.ts <dist-dir> <site>`. You can compare it with a previous build using `admin/bench/compareHtml.ts`.

### Gotchas

- `tsc` doesn't delete the outputs of deleted source files. When upstream deletes or renames source files, delete the `lib/` folders of the affected packages before `bun run build:packages`. Otherwise stale modules stay in the build: for example, the theme-translations test finds messages from a deleted theme component.
- Code that rewrites JS/MDX sources (as the Bun plugin does for text imports and `new URL()`) must skip string literals. MDX compiles code blocks to strings, and the docs often show the syntax being rewritten.
- The `strip-hash` pattern in `build-perf.yml` must match Bun's 8-char chunk hashes, not Webpack's.
- On some Linux filesystems, `readdir` returns files in creation order. Tests that depend on glob order, such as same-date blog posts, fail when the merge rewrites their fixtures. They also fail in a fresh checkout. Run the failing tests on the pre-merge commit, in a fresh `git worktree`, before blaming the merge.
- Local benchmark sites (`bench-sites/`, gitignored) are not workspaces, so `bun install` keeps them out of `bun.lock`. Test them with the packed packages: `bun admin/scripts/packForSite.ts <dist-dir> <site>`. Never add them back to the root `workspaces`: CI runs `bun install --frozen-lockfile` without them.

## 6. Commit

Update `BUNOSAURUS.md` when user-facing behavior changed: new breaking changes or features the fork doesn't support. New `packages/*` are published automatically under `@azerion/bunosaurus-*` (`admin/scripts/publishedPackages.ts`). Check that's what you want.

Commit the merge with a message like:

```
chore: merge upstream Docusaurus <upstream short sha> (AI-assisted)

Ported to the Bun bundler: <commits>
Translated to Bun: <commits>
Dropped (Node/pnpm/Webpack only): <commits>
```

Don't push or open a PR unless asked.

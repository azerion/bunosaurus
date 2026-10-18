# Bunosaurus

Bunosaurus is a fork of [Docusaurus](https://docusaurus.io) v4 that runs on [Bun](https://bun.sh) only, and bundles sites with [`Bun.build()`](https://bun.sh/docs/bundler) instead of Webpack/Rspack.

Requirements: Bun `>= 1.4.1`. Node.js is not supported.

## What changed compared to Docusaurus

### Toolchain

- The monorepo uses Bun workspaces (`bun install`, `bun run`), pnpm and Lerna are gone. Packages are versioned and published with `admin/scripts/release.ts` (packed with `bun pm pack`; the Publish workflow publishes them with the npm CLI, for npm trusted publishing).
- All GitHub workflows, the devcontainer, Gitpod and Netlify use Bun.
- Tests still use Vitest, running on the Bun runtime (`bun run test`). DOM tests use `happy-dom` (jsdom doesn't run on Bun) and Vitest is patched (`patches/vitest@*.patch`) to locate inline snapshots on JavaScriptCore stack traces.
- The `docusaurus` and `create-docusaurus` CLIs require Bun.

### Bundler

The bundler lives in `packages/docusaurus-bundler/src/bun` (generic parts) and `packages/docusaurus/src/bundler` (Docusaurus-specific parts).

- **Production build**: the client (browser, code-split ES modules) and server (single ES module for SSG) bundles are built concurrently with `Bun.build()`. The client manifest that maps rendered modules to their chunks is derived from the Bun metafile (`bundler/manifest.ts`), replacing `react-loadable-ssr-addon`. Pages load the client entry with `<script type="module">` and their route chunks with `<link rel="modulepreload">`.
- **Plugins keep using `configureWebpack()`**: instead of rewriting every plugin, the Bun bundler interprets the subset of the Webpack config that Docusaurus sites rely on (`webpackCompat.ts`): `resolve.alias`, `module.rules` (loaders run through a minimal loader runner, `loaderRunner.ts`), `DefinePlugin`, `EnvironmentPlugin` and `ContextReplacementPlugin`. MDX, blog truncation, SVGR and ideal-image loaders work unchanged. `configurePostCss()` plugins are applied to client CSS (cascade layers, RTL). Other Webpack plugins and options are ignored with a warning.
- **Assets**: images, fonts and files imported from JS/MDX, referenced with `new URL('./img.png', import.meta.url)`, and CSS `url()`s, get stable content-hashed URLs (`assets.ts`). Like Webpack asset modules, `require('./img.png')` returns the URL string. Docusaurus asset requests (`!./img.png?docusaurus-asset=image`) and inline Webpack loader strings (`!url-loader?…!./img.png`) are understood. Assets are always emitted as files: small assets are not inlined as data URLs, and `DOCUSAURUS_ASSET_INLINE_MAX_SIZE` is ignored.
- **Loader cache**: loader results (mostly MDX compilation) are shared by the client and server bundles, and persisted in `node_modules/.cache/docusaurus/loaders`. Set `DOCUSAURUS_NO_PERSISTENT_CACHE=true` to disable it.
- **SSG** runs in a pool of Bun child processes (`ssg/ssgWorkerProcess.ts`): Bun worker threads don't scale for this CPU-bound work.
- **Localized sites**: each locale finishes its build (SSG, `postBuild`, broken links check) while the next locale is bundled. Set `DOCUSAURUS_BUILD_LOCALES_SEQUENTIALLY=true` to build locales one after the other.
- **Dev server** (`docusaurus start`): built on `Bun.serve()`. The app is rebuilt on file changes (cached loader results make rebuilds fast), and the browser applies a hot update when possible (`bundler/hotUpdate.ts`):
  - route modules (MDX content and its TOC/front matter, page components, route data) are re-imported and the routes using them re-render, without reloading the page;
  - CSS changes swap the stylesheet;
  - saves that don't change the output do nothing;
  - other changes (theme components, config, new routes...) reload the page. There is no React Fast Refresh: component state of updated routes is reset.

  Chunk URLs are kept stable across dev rebuilds: Bun chunk hashes change when an imported chunk changes, and the entry chunk (which contains the route registry) changes on every route edit. HTTPS requires `--ssl-cert` and `--ssl-key`.

### Breaking changes

- Webpack/Rspack, `siteConfig.webpack`, `@docusaurus/faster` and `@docusaurus/plugin-rsdoctor` are gone. `future.faster` and `future.v4` (Docusaurus v3) are accepted with a warning and ignored.
- `currentBundler.instance` (in `configureWebpack()` utils) is a shim that only exposes the Webpack plugins listed above.
- The SSG output uses ES modules: a custom `ssrTemplate` must render `it.scripts` with `<script type="module">`, and can render `it.modulePreloads` as `<link rel="modulepreload">`.
- The generated route registry no longer contains Webpack chunk names (`require.resolveWeak`).

## Published packages

The packages are published under the `@azerion` scope with a `bunosaurus-` prefix (`admin/scripts/publishedPackages.ts`): `@docusaurus/core` is published as `@azerion/bunosaurus-core`, `@docusaurus/plugin-content-docs` as `@azerion/bunosaurus-plugin-content-docs`, and `create-docusaurus` as `@azerion/create-bunosaurus`. All the public packages of `packages/` are published, except the repo linting tools (`@docusaurus/eslint-plugin`, `stylelint-copyright`).

Sites still install them under their `@docusaurus/*` names, with npm aliases: Docusaurus resolves its packages by these names (presets, plugin shorthands, swizzle, theme imports, swizzled components), so Bunosaurus is a drop-in replacement. The published packages depend on each other the same way (`"@docusaurus/utils": "npm:@azerion/bunosaurus-utils@<version>"`).

Release: `bun admin/scripts/release.ts version <version>`, then `bun admin/scripts/release.ts publish --tag <tag>` (`pack <dir>` creates the renamed tarballs without publishing).

## Creating a new site

```bash
bun create @azerion/bunosaurus my-website classic
```

## Using Bunosaurus in an existing Docusaurus site

1. In the site `package.json`:
   - replace the `@docusaurus/*` dependencies with aliases to the Bunosaurus packages, for example `"@docusaurus/core": "npm:@azerion/bunosaurus-core@<version>"`, `"@docusaurus/preset-classic": "npm:@azerion/bunosaurus-preset-classic@<version>"`;
   - remove `@docusaurus/faster` and `@rspack/core`;
   - upgrade `react` and `react-dom` to `^19.3.0`;
   - set `"engines": {"bun": ">=1.4.1"}`.

2. In `docusaurus.config`, remove `future.faster` / `future.v4`.

3. Install and build with Bun: `bun install`, `bun run build`, `bun run start`.

When the site is a workspace of a monorepo using Bun's isolated linker, swizzled components must declare the packages they import (for example `@docusaurus/theme-common`) as dependencies.

To test unpublished changes, pack the packages of this repo and point a site to the tarballs with `overrides`:

```bash
bun install
bun admin/scripts/packForSite.ts /path/to/dist-packages /path/to/site
```

## Benchmarks

Site: [Improve Digital Yield docs](https://docs.app.improvedigital.com) (~415 Markdown files, 9 docs plugin instances, 2 blogs, `en` + `fr`, 1208 pages).

Baseline: Docusaurus 3.10 with `future.faster` (Rspack, SWC, LightningCSS) on Node.js 24. Machine: AMD Ryzen AI 9 HX 370 laptop (power-limited, 12 cores). Builds interleaved, 4 runs each, median.

|  | Baseline | Bunosaurus |  |
| --- | --- | --- | --- |
| Production build, cold (no cache) | 24.9s | 16.1s | -35% |
| Production build, warm (persistent cache) | 15.8s | 10.0s | -37% |
| Dev server ready, cold | 8.2s | 5.1s | -38% |
| Dev server ready, warm |  | 2.1s |  |
| Dev server, rebuild after editing a doc | 0.4s (HMR) | 0.6s (hot update) |  |

Benchmark scripts: `admin/bench/bench.sh` (build timings) and `admin/bench/compareHtml.ts` (compares the rendered content of 2 builds).

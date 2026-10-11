Sometimes you want to test the latest version of Docusaurus on a third-party project without having to publish it to npm itself. For example, you may want to use the latest code in `main`.

> If you want to use Docusaurus to test Docusaurus, see the [testing changes on Docusaurus itself doc](./testing-changes-on-Docusaurus-itself.md)

There are two reasonable ways to use a local version of the Docusaurus npm packages to test changes you make to the Docusaurus core on a third-party project.

## Install packed tarballs in an existing project

Let's say you have an existing project with this snippet inside package.json:

```json
{
  "dependencies": {
    "@docusaurus/core": "4.0.0",
    "@docusaurus/preset-classic": "4.0.0"
  }
}
```

Now, you have made changes to @docusaurus/core (this lives in packages/docusaurus) and would like to test the changes. In the local docusaurus repo, run `bun install`. This will also build the local docusaurus packages:

```sh
cd /path/to/local/docusaurus
# can use "bun run build:packages" if dependencies have not been modified
bun install
```

Then pack all the packages as tarballs, and add the package.json `overrides` that make the existing project use them, including for transitive dependencies:

```sh
bun admin/scripts/packForSite.ts /path/to/dist-packages /path/to/existing/project
```

Without the second argument, the script only prints the `overrides` to add.

Install the existing project dependencies:

```sh
cd /path/to/existing/project
bun install
```

If you make further changes to the local docusaurus repo, run `bun run build:packages` and `packForSite.ts` again, then reinstall the existing project dependencies (the tarball names don't change, so you may have to remove the `node_modules` folder and lockfile first).

## Use Verdaccio

Verdaccio is a good local npm server that you can use to test your packages.

We have a script `test:build:website` that starts a docker with verdaccio, publishes the packages, and initializes a new website in the parent directory. Alternatively, to install a package in the existing project, after you have started the verdaccio service, run

```bash
BUN_CONFIG_REGISTRY="http://localhost:4873" bun add @docusaurus/core@"4.0.0-NEW-1234" # The version should be the latest
```

You can refer to [the implementation](./scripts/test-release.sh) for more details.

If you don't have docker, you can still invoke the CLI manually to start the service.

```bash
bunx verdaccio --listen 4873 --config admin/verdaccio.yaml
```

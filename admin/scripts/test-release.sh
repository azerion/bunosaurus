#!/usr/bin/env bash

# Copyright (c) Facebook, Inc. and its affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

set -xeuo pipefail

rm -rf ../test-website

CUSTOM_REGISTRY_URL="http://localhost:4873"
NEW_VERSION="$(bun -p "require('./packages/docusaurus/package.json').version")-NEW-$RANDOM"
CONTAINER_NAME="verdaccio"
EXTRA_OPTS=""

usage() { echo "Usage: $0 [-s] [-t]" 1>&2; exit 1; }

while getopts ":st" o; do
  case "${o}" in
    s)
      EXTRA_OPTS="${EXTRA_OPTS} --skip-install"
      ;;
    t)
      EXTRA_OPTS="${EXTRA_OPTS} --typescript"
      ;;
    *)
      usage
      ;;
  esac
done
shift $((OPTIND-1))


if [ -n "$EXTRA_OPTS" ]
then
  echo create-docusaurus extra options = ${EXTRA_OPTS}
fi

# Run Docker container with private npm registry Verdaccio
docker rm -f verdaccio
docker run -d --rm --name "$CONTAINER_NAME" -p 4873:4873 -v "$PWD/admin/verdaccio.yaml":/verdaccio/conf/config.yaml verdaccio/verdaccio:latest

# Build packages
bun run build:packages

# Publish the monorepo
bun admin/scripts/release.ts version "$NEW_VERSION"
# Verdaccio accepts anonymous publishing, but "bun publish" requires a token
NPM_CONFIG_TOKEN=verdaccio-anonymous \
  bun admin/scripts/release.ts publish --tag e2e --registry "$CUSTOM_REGISTRY_URL"

# Revert version changes
git restore -- '**/package.json' bun.lock


# The website is generated outside the repo, so that it doesn't use the monorepo workspace
cd ..

echo Generating test-website in `pwd`

# Build skeleton website with new version
# A fresh cache dir avoids resolving versions from cached registry metadata
BUN_CONFIG_REGISTRY="$CUSTOM_REGISTRY_URL" \
  BUN_INSTALL_CACHE_DIR="$(mktemp -d)" \
  bunx --bun @azerion/create-bunosaurus@"$NEW_VERSION" test-website classic --javascript $EXTRA_OPTS


# Stop Docker container
if [[ -z "${KEEP_CONTAINER:-true}" ]] && ( $(docker container inspect "$CONTAINER_NAME" > /dev/null 2>&1) ); then
  # Remove Docker container
  docker container stop $CONTAINER_NAME > /dev/null
fi

echo "The website with to-be published packages was successfully build to the $(tput setaf 2)test-website$(tput sgr 0) directory."

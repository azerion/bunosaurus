#!/usr/bin/env bash

# Copyright (c) Facebook, Inc. and its affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

samply record -- env DOCUSAURUS_EXIT_AFTER_BUNDLING=true bun ./node_modules/.bin/docusaurus build --locale en

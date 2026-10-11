/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {Eta} from 'eta';
import {PerfLogger} from '@docusaurus/logger';
import type {SSGParams} from './ssgParams';
import type {AppRenderResult} from '../common';
import type {ClientManifest} from '../bundler/manifest';

// TODO Docusaurus v4 breaking change - this is historical server template data
//  that does not look super clean nor typesafe
//  Note: changing it is a breaking change because template is configurable
type SSGTemplateData = {
  appHtml: string;
  baseUrl: string;
  htmlAttributes: string;
  bodyAttributes: string;
  headTags: string;
  preBodyTags: string;
  postBodyTags: string;
  metaAttributes: string[];
  /** ES module scripts (the client entry) */
  scripts: string[];
  /** ES modules that the page needs (route chunks) */
  modulePreloads: string[];
  stylesheets: string[];
  noIndex: boolean;
  version: string;
};

export type SSGTemplateCompiled = (data: SSGTemplateData) => string;

export async function compileSSGTemplate(
  template: string,
): Promise<SSGTemplateCompiled> {
  const eta = new Eta({rmWhitespace: true});
  const compiledTemplate = eta.compile(template.trim());

  return (data: SSGTemplateData) => eta.render(compiledTemplate, data);
}

/**
 * Given the list of modules rendered for a page, returns the client assets
 * that this page needs, based on the client manifest
 */
function getScriptsAndStylesheets({
  modules,
  manifest,
}: {
  modules: string[];
  manifest: ClientManifest;
}) {
  const modulePreloads = new Set<string>();
  modules.forEach((modulePath) => {
    manifest.modules[modulePath]?.forEach((file) => modulePreloads.add(file));
  });
  return {
    scripts: manifest.entry.js,
    stylesheets: manifest.entry.css,
    modulePreloads: [...modulePreloads],
  };
}

export function renderSSGTemplate({
  params,
  result,
  ssgTemplate,
}: {
  params: SSGParams;
  result: AppRenderResult;
  ssgTemplate: SSGTemplateCompiled;
}): string {
  const {
    baseUrl,
    headTags,
    preBodyTags,
    postBodyTags,
    manifest,
    noIndex,
    DOCUSAURUS_VERSION,
  } = params;
  const {
    html: appHtml,
    collectedData: {modules, metadata},
  } = result;

  const {scripts, stylesheets, modulePreloads} = getScriptsAndStylesheets({
    manifest,
    modules,
  });

  const {htmlAttributes, bodyAttributes} = metadata.internal;
  const metaStrings = [
    metadata.internal.title,
    metadata.internal.meta,
    metadata.internal.link,
    metadata.internal.script,
  ];
  const metaAttributes = metaStrings.filter(Boolean);

  const data: SSGTemplateData = {
    appHtml,
    baseUrl,
    htmlAttributes,
    bodyAttributes,
    headTags,
    preBodyTags,
    postBodyTags,
    metaAttributes,
    scripts,
    modulePreloads,
    stylesheets,
    noIndex,
    version: DOCUSAURUS_VERSION,
  };

  return ssgTemplate(data);
}

export async function renderHashRouterTemplate({
  params,
}: {
  params: SSGParams;
}): Promise<string> {
  const {
    // baseUrl,
    headTags,
    preBodyTags,
    postBodyTags,
    manifest,
    DOCUSAURUS_VERSION,
    ssgTemplateContent,
  } = params;

  const ssgTemplate = await PerfLogger.async('Compile SSG template', () =>
    compileSSGTemplate(ssgTemplateContent),
  );

  const {scripts, stylesheets, modulePreloads} = getScriptsAndStylesheets({
    manifest,
    modules: [],
  });

  const data: SSGTemplateData = {
    appHtml: '',
    baseUrl: './',
    htmlAttributes: '',
    bodyAttributes: '',
    headTags,
    preBodyTags,
    postBodyTags,
    metaAttributes: [],
    scripts,
    modulePreloads,
    stylesheets,
    noIndex: false,
    version: DOCUSAURUS_VERSION,
  };

  return ssgTemplate(data);
}

/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Compares the rendered content of two Docusaurus build output dirs.
// Usage: bun admin/bench/compareHtml.ts <baselineBuildDir> <candidateBuildDir>
// For each HTML page, compares the normalized text of <main> and the <title>.

import path from 'node:path';

const [baselineDir, candidateDir] = process.argv.slice(2);
// Optional known differences to ignore, ex: COMPARE_IGNORE='["View All Tags"]'
const ignored: string[] = JSON.parse(process.env.COMPARE_IGNORE ?? '[]');
const maxPrinted = Number(process.env.COMPARE_MAX_PRINTED ?? 20);
if (!baselineDir || !candidateDir) {
  throw new Error(
    'Usage: compareHtml.ts <baselineBuildDir> <candidateBuildDir>',
  );
}

async function extract(file: string): Promise<{title: string; main: string}> {
  let title = '';
  let main = '';
  let inMain = 0;
  let inTitle = false;
  const rewriter = new HTMLRewriter()
    .on('title', {
      element(el) {
        inTitle = true;
        el.onEndTag(() => {
          inTitle = false;
        });
      },
    })
    .on('main', {
      element(el) {
        inMain += 1;
        el.onEndTag(() => {
          inMain -= 1;
        });
      },
    })
    .on('*', {
      text(chunk) {
        if (inTitle) {
          title += chunk.text;
        }
        if (inMain > 0) {
          main += chunk.text;
        }
      },
    });
  await rewriter.transform(new Response(Bun.file(file))).text();
  for (const str of ignored) {
    main = main.replaceAll(new RegExp(str, 'gi'), '');
  }
  return {title: title.trim(), main: main.replace(/\s+/g, ' ').trim()};
}

const glob = new Bun.Glob('**/*.html');
const files = (await Array.fromAsync(glob.scan({cwd: baselineDir}))).sort();
let identical = 0;
const different: string[] = [];
const missing: string[] = [];

await Promise.all(
  files.map(async (file) => {
    const candidateFile = path.join(candidateDir, file);
    if (!(await Bun.file(candidateFile).exists())) {
      missing.push(file);
      return;
    }
    const [a, b] = await Promise.all([
      extract(path.join(baselineDir, file)),
      extract(candidateFile),
    ]);
    if (a.title === b.title && a.main === b.main) {
      identical += 1;
    } else {
      different.push(file);
    }
  }),
);

console.log(
  `pages=${files.length} identical=${identical} different=${different.length} missing=${missing.length}`,
);
for (const file of different.sort().slice(0, maxPrinted)) {
  const [a, b] = await Promise.all([
    extract(path.join(baselineDir, file)),
    extract(path.join(candidateDir, file)),
  ]);
  let i = 0;
  while (i < a.main.length && a.main[i] === b.main[i]) {
    i += 1;
  }
  console.log(
    `\n${file}${a.title !== b.title ? ` (title: "${a.title}" vs "${b.title}")` : ''}`,
  );
  console.log(`  baseline:  …${a.main.slice(Math.max(0, i - 60), i + 80)}`);
  console.log(`  candidate: …${b.main.slice(Math.max(0, i - 60), i + 80)}`);
}
for (const file of missing.slice(0, 20)) {
  console.log(`missing: ${file}`);
}
process.exitCode = different.length + missing.length > 0 ? 1 : 0;

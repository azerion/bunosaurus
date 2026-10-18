/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {describe, expect, it} from 'vitest';
import {replaceNewURLs} from '../newURL';

function replace(code: string): string {
  return replaceNewURLs(code, (request) =>
    request.startsWith('http') ? undefined : `ASSET(${request})`,
  );
}

describe('replaceNewURLs', () => {
  it('replaces new URL() expressions', () => {
    expect(
      replace(
        `const a = new URL('./a.png', import.meta.url).href;
const b = new URL( "../b.pdf" ,import.meta.url );
f(new URL('@site/c.svg', import.meta.url), x/2);
const d = new URL(
  './d.png',
  import.meta.url,
).href;`,
      ),
    ).toBe(`const a = ASSET(./a.png).href;
const b = ASSET(../b.pdf);
f(ASSET(@site/c.svg), x/2);
const d = ASSET(./d.png).href;`);
  });

  it('keeps unsupported expressions', () => {
    const code = `new URL('https://example.com', import.meta.url);
new URL(path, import.meta.url);
new URL('./a.png', base);
renew URL('./a.png', import.meta.url);
new URL(\`./a.png\`, import.meta.url);`;
    expect(replace(code)).toBe(code);
  });

  it('skips strings, comments and regexps', () => {
    const code = `const s = "new URL('./a.png', import.meta.url)";
const t = 'it\\'s new URL("./a.png", import.meta.url)';
// new URL('./a.png', import.meta.url)
/* new URL('./a.png', import.meta.url) */
const r = /"/; const u = "new URL('./a.png', import.meta.url)";
const tpl = \`new URL('./a.png', import.meta.url) \${"}"} new URL('./a.png', import.meta.url)\`;`;
    expect(replace(code)).toBe(code);
  });

  it('replaces expressions in template literal placeholders', () => {
    expect(
      replace(
        "const a = `${new URL('./a.png', import.meta.url)} and ${{a: 1}.a}`; new URL('./b.png', import.meta.url);",
      ),
    ).toBe('const a = `${ASSET(./a.png)} and ${{a: 1}.a}`; ASSET(./b.png);');
  });
});

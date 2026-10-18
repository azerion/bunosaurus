/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// new URL('./img.png', import.meta.url) with a static string literal
const NewURLRegExp =
  /new\s+URL\(\s*(['"])([^'"\\\n]+)\1\s*,\s*import\.meta\.url\s*(?:,\s*)?\)/y;

// After these chars, "/" starts a regexp literal, not a division
const RegExpPrecedingChars = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));

/**
 * Replaces the new URL('./path', import.meta.url) expressions of JS/TS/JSX
 * code, skipping string literals, template literal strings, comments and
 * regexp literals: MDX code blocks are compiled to string literals and may
 * contain such examples.
 */
export function replaceNewURLs(
  code: string,
  replace: (request: string) => string | undefined,
): string {
  if (!code.includes('import.meta.url')) {
    return code;
  }
  let result = '';
  let copiedUntil = 0;
  // Template literal nesting: brace depth of each "${" expression
  const templateBraceDepths: number[] = [];
  let braceDepth = 0;
  let lastSignificantChar = '';
  let i = 0;

  // Skips a string literal or a template literal string part, starting after
  // its opening quote. Returns true if a template literal "${" was entered.
  function skipString(quote: string): boolean {
    while (i < code.length) {
      const char = code[i]!;
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === quote) {
        i += 1;
        return false;
      }
      if (quote === '`' && char === '$' && code[i + 1] === '{') {
        i += 2;
        templateBraceDepths.push(braceDepth);
        braceDepth += 1;
        return true;
      }
      if (char === '\n' && quote !== '`') {
        // Unterminated string: give up on it
        return false;
      }
      i += 1;
    }
    return false;
  }

  function skipRegExp() {
    let inClass = false;
    while (i < code.length) {
      const char = code[i]!;
      if (char === '\\') {
        i += 2;
        continue;
      }
      i += 1;
      if (char === '\n') {
        return;
      }
      if (inClass) {
        inClass = char !== ']';
      } else if (char === '[') {
        inClass = true;
      } else if (char === '/') {
        return;
      }
    }
  }

  while (i < code.length) {
    const char = code[i]!;
    const next = code[i + 1];
    if (char === '"' || char === "'" || char === '`') {
      i += 1;
      skipString(char);
      lastSignificantChar = char;
      continue;
    }
    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      i = end === -1 ? code.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (
      char === '/' &&
      (lastSignificantChar === '' ||
        RegExpPrecedingChars.has(lastSignificantChar))
    ) {
      i += 1;
      skipRegExp();
      lastSignificantChar = '/';
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
    } else if (char === '}') {
      braceDepth -= 1;
      // End of a template literal "${}" expression: back to the string
      if (templateBraceDepths.at(-1) === braceDepth) {
        templateBraceDepths.pop();
        i += 1;
        skipString('`');
        lastSignificantChar = '`';
        continue;
      }
    } else if (char === 'n' && !/[\w$]/.test(code[i - 1] ?? '')) {
      NewURLRegExp.lastIndex = i;
      const match = NewURLRegExp.exec(code);
      const replacement = match ? replace(match[2]!) : undefined;
      if (match && replacement !== undefined) {
        result += code.slice(copiedUntil, i) + replacement;
        i += match[0].length;
        copiedUntil = i;
        lastSignificantChar = ')';
        continue;
      }
    }
    if (!/\s/.test(char)) {
      lastSignificantChar = char;
    }
    i += 1;
  }
  return copiedUntil === 0 ? code : result + code.slice(copiedUntil);
}

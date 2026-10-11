/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Minimal implementation of the Webpack "RuleSetCondition" semantics, used to
 * interpret the module rules that plugins still contribute through
 * configureWebpack(). See https://webpack.js.org/configuration/module/#condition
 */
export type Condition =
  | RegExp
  | string
  | ((value: string) => boolean)
  | Condition[]
  | {and?: Condition[]; or?: Condition[]; not?: Condition};

export function matchCondition(
  condition: Condition | undefined,
  value: string,
): boolean {
  if (condition === undefined) {
    return true;
  }
  if (condition instanceof RegExp) {
    // Reset in case of a global/sticky regexp
    condition.lastIndex = 0;
    return condition.test(value);
  }
  if (typeof condition === 'string') {
    // Webpack: string conditions match path prefixes
    return value.startsWith(condition);
  }
  if (typeof condition === 'function') {
    return condition(value);
  }
  if (Array.isArray(condition)) {
    return condition.some((c) => matchCondition(c, value));
  }
  const {and, or, not} = condition;
  if (and && !and.every((c) => matchCondition(c, value))) {
    return false;
  }
  if (or && !or.some((c) => matchCondition(c, value))) {
    return false;
  }
  if (not !== undefined && matchCondition(not, value)) {
    return false;
  }
  return true;
}

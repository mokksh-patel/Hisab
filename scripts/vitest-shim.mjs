/**
 * vitest-shim.mjs — a minimal `vitest` replacement backed by node:test.
 *
 * Implements only what the BizPilot unit tests use:
 *   describe, it, test, expect (toBe, toEqual, toBeNull, toBeUndefined,
 *   toBeTruthy, toBeFalsy, toThrow, toContain, toHaveLength, toBeGreaterThan,
 *   toBeLessThan, toBeGreaterThanOrEqual, toBeLessThanOrEqual, not.*)
 *
 * This is a test-runner shim, not a production dependency.
 */

import { describe as nodeDescribe, it as nodeIt, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';

export const describe = nodeDescribe;

/** `it`/`test` with Vitest's `.each` table support. */
function makeTest(base) {
  const wrapped = (name, fn) => base(name, fn);
  wrapped.each = (table) => (name, fn) => {
    for (const row of table) {
      const args = Array.isArray(row) ? row : [row];
      const label = typeof name === 'function' ? name(...args) : `${name} [${args.map(String).join(', ')}]`;
      base(label, () => fn(...args));
    }
  };
  wrapped.skip = base.skip;
  wrapped.only = base.only;
  wrapped.todo = base.todo;
  return wrapped;
}

export const it = makeTest(nodeIt);
export const test = makeTest(nodeTest);

function buildMatchers(actual, negated = false) {
  const check = (pass, message) => {
    if (negated ? pass : !pass) {
      assert.fail(negated ? `Expected NOT: ${message}` : message);
    }
  };

  const matchers = {
    toBe(expected) {
      check(
        Object.is(actual, expected),
        `expected ${format(actual)} to be ${format(expected)}`,
      );
    },
    toEqual(expected) {
      let pass = true;
      try {
        assert.deepEqual(actual, expected);
      } catch {
        pass = false;
      }
      check(pass, `expected ${format(actual)} to equal ${format(expected)}`);
    },
    toStrictEqual(expected) {
      let pass = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        pass = false;
      }
      check(pass, `expected ${format(actual)} to strictly equal ${format(expected)}`);
    },
    toBeNull() {
      check(actual === null, `expected ${format(actual)} to be null`);
    },
    toBeUndefined() {
      check(actual === undefined, `expected ${format(actual)} to be undefined`);
    },
    toBeDefined() {
      check(actual !== undefined, 'expected value to be defined');
    },
    toBeTruthy() {
      check(Boolean(actual), `expected ${format(actual)} to be truthy`);
    },
    toBeFalsy() {
      check(!actual, `expected ${format(actual)} to be falsy`);
    },
    toContain(expected) {
      const pass = typeof actual === 'string' ? actual.includes(expected) : Array.from(actual).includes(expected);
      check(pass, `expected ${format(actual)} to contain ${format(expected)}`);
    },
    toHaveLength(expected) {
      check(actual?.length === expected, `expected length ${expected}, received ${actual?.length}`);
    },
    toBeGreaterThan(expected) {
      check(actual > expected, `expected ${format(actual)} > ${format(expected)}`);
    },
    toBeGreaterThanOrEqual(expected) {
      check(actual >= expected, `expected ${format(actual)} >= ${format(expected)}`);
    },
    toBeLessThan(expected) {
      check(actual < expected, `expected ${format(actual)} < ${format(expected)}`);
    },
    toBeLessThanOrEqual(expected) {
      check(actual <= expected, `expected ${format(actual)} <= ${format(expected)}`);
    },
    toBeCloseTo(expected, digits = 2) {
      const pass = Math.abs(actual - expected) < Math.pow(10, -digits) / 2;
      check(pass, `expected ${format(actual)} to be close to ${format(expected)}`);
    },
    toThrow(expected) {
      let threw = false;
      let error;
      try {
        actual();
      } catch (caught) {
        threw = true;
        error = caught;
      }
      if (!threw) {
        check(false, 'expected function to throw');
        return;
      }
      if (expected === undefined) {
        check(true, '');
        return;
      }
      if (typeof expected === 'string') {
        check(
          String(error?.message ?? '').includes(expected),
          `expected error message to include "${expected}", received "${error?.message}"`,
        );
        return;
      }
      if (expected instanceof RegExp) {
        check(expected.test(String(error?.message ?? '')), `expected error message to match ${expected}`);
        return;
      }
      if (typeof expected === 'function') {
        check(error instanceof expected, `expected error to be instance of ${expected.name}`);
        return;
      }
      check(true, '');
    },
    toMatch(expected) {
      const pass =
        expected instanceof RegExp
          ? expected.test(String(actual))
          : String(actual).includes(String(expected));
      check(pass, `expected ${format(actual)} to match ${expected}`);
    },
    toMatchObject(expected) {
      check(matchesSubset(actual, expected), `expected ${format(actual)} to match object ${format(expected)}`);
    },
  };

  if (!negated) {
    matchers.not = buildMatchers(actual, true);
  }

  return matchers;
}

function format(value) {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Recursive subset match, mirroring Vitest's toMatchObject semantics. */
function matchesSubset(actual, expected) {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(actual, expected);
  }
  if (actual === null || typeof actual !== 'object') return false;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => matchesSubset(actual[index], item));
  }

  return Object.keys(expected).every((key) => matchesSubset(actual[key], expected[key]));
}

export function expect(actual) {
  return buildMatchers(actual);
}

expect.extend = () => {};
expect.any = (ctor) => ({ __any: ctor });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPushFailure, validPushTarget } from '../src/push.js';

test('publickey denial with exit 128 needs the user, not a retry', () => {
  const c = classifyPushFailure(128, 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.');
  assert.equal(c.needsUser, true);
});

test('other failures are not marked as needing the user', () => {
  assert.equal(classifyPushFailure(1, 'error: failed to push some refs').needsUser, false);
  assert.equal(classifyPushFailure(128, 'fatal: repository not found').needsUser, false);
});

test('branch and remote names are checked before any push', () => {
  assert.equal(validPushTarget('fix/retry-budget-cap', 'origin'), null);
  assert.notEqual(validPushTarget('--force', 'origin'), null);
  assert.notEqual(validPushTarget('a..b', 'origin'), null);
  assert.notEqual(validPushTarget('main', 'ori gin'), null);
});

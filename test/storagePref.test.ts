/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storageManager } from '../src/lib/storage.ts';

test('auto refresh preference persisted', async () => {
  storageManager.setAutoRefreshInterval(60000);
  const v = storageManager.getAutoRefreshInterval();
  assert.equal(v, 60000);
  storageManager.setAutoRefreshInterval(null);
  assert.equal(storageManager.getAutoRefreshInterval(), null);
});

test('vault enabled persisted', async () => {
  storageManager.setVaultEnabled(true);
  assert.equal(storageManager.getVaultEnabled(), true);
  storageManager.setVaultEnabled(false);
  assert.equal(storageManager.getVaultEnabled(), false);
});

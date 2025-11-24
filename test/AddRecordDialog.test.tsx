import assert from 'node:assert/strict';
import React from 'react';
import { create } from 'react-test-renderer';
import { test } from 'node:test';

import { AddRecordDialog } from '../src/components/dns/AddRecordDialog';

const noop = () => {};

test('AddRecordDialog renders fields and aria-labels for TLSA', () => {
  const record = { type: 'TLSA', name: 'test', content: '1 2 3 abc' };
  const r = create(
    React.createElement(AddRecordDialog, {
      open: true,
      onOpenChange: noop,
      record,
      onRecordChange: noop,
      onAdd: noop,
      zoneName: 'example.com',
    }),
  );
  const root = r.root;
  // Name input should have aria-label set
  const name = root.findAllByProps({ 'aria-label': 'Name' });
  assert.ok(name.length >= 1);
  // TLSA data field should exist and be labelled 'data'
  const tlsa = root.findAllByProps({ 'aria-label': 'data' });
  assert.ok(tlsa.length >= 1);
});

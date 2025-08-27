import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { filterRecords } from '../src/components/dns/filter-records.ts';
import type { DNSRecord } from '../src/types/dns';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.navigator = dom.window.navigator as Navigator;

const { render, screen, fireEvent } = await import('@testing-library/react');

const records: DNSRecord[] = [
  {
    id: '1',
    type: 'A',
    name: 'www',
    content: '1.1.1.1',
    ttl: 300,
    zone_id: 'z',
    zone_name: 'example.com',
    created_on: '',
    modified_on: '',
  },
  {
    id: '2',
    type: 'CNAME',
    name: 'api',
    content: 'api.example.com',
    ttl: 300,
    zone_id: 'z',
    zone_name: 'example.com',
    created_on: '',
    modified_on: '',
  },
];

test('filterRecords matches name, type, or content', () => {
  assert.equal(filterRecords(records, 'www').length, 1);
  assert.equal(filterRecords(records, 'cname').length, 1);
  assert.equal(filterRecords(records, 'api.example').length, 1);
  assert.equal(filterRecords(records, 'missing').length, 0);
});

test('component filters displayed records by search term', () => {
  function Wrapper(): React.ReactElement {
    const [term, setTerm] = React.useState('');
    const filtered = filterRecords(records, term);
    return React.createElement(
      'div',
      null,
      React.createElement('input', {
        'aria-label': 'search',
        value: term,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTerm(e.target.value),
      }),
      React.createElement(
        'ul',
        null,
        filtered.map((r) =>
          React.createElement('li', { key: r.id }, `${r.name}-${r.type}-${r.content}`),
        ),
      ),
    );
  }

  render(React.createElement(Wrapper));
  const input = screen.getByLabelText('search') as HTMLInputElement;
  assert.equal(screen.getAllByRole('listitem').length, 2);

  fireEvent.change(input, { target: { value: 'www' } });
  assert.equal(screen.getAllByRole('listitem').length, 1);
  assert.ok(screen.getByText('www-A-1.1.1.1'));

  fireEvent.change(input, { target: { value: 'cname' } });
  assert.equal(screen.getAllByRole('listitem').length, 1);
  assert.ok(screen.getByText('api-CNAME-api.example.com'));
});

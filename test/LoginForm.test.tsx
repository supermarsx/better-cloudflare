import assert from 'node:assert/strict';
import React from 'react';
import { create } from 'react-test-renderer';
import { test } from 'node:test';

import { LoginForm } from '../src/components/auth/login-form';

test('LoginForm renders login button', () => {
  const r = create(React.createElement(LoginForm, { onLogin: () => {} }));
  const btn = r.root.findAllByType('button').find((b) => String(b.children).includes('Login'));
  assert.ok(btn);
});

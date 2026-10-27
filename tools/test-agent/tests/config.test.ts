import { expect, it } from 'vitest';
import { assertSandboxAllowed } from '../src/config.ts';

it('refuses unsandboxed PR runs unless explicitly allowed', () => {
  expect(() => assertSandboxAllowed('pr', 'local', {})).toThrow('TEST_AGENT_SANDBOX=docker');
  expect(() => assertSandboxAllowed('pr', 'local', { TEST_AGENT_ALLOW_UNSANDBOXED: '1' })).not.toThrow();
  expect(() => assertSandboxAllowed('pr', 'docker', {})).not.toThrow();
  expect(() => assertSandboxAllowed('coverage', 'local', {})).not.toThrow();
});

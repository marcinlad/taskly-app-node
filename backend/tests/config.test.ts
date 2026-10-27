import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { resolveDatabaseUrl } from '../src/core/config.ts';

const parts = { POSTGRES_USER: 'taskly', POSTGRES_PASSWORD: 'secret', POSTGRES_HOST: 'db.internal', DB_PORT: '5433', POSTGRES_DB: 'tasks' };

beforeEach(() => {
  // Neutralize values loaded from a local .env file.
  vi.stubEnv('DATABASE_URL', '');
  for (const name of Object.keys(parts)) vi.stubEnv(name, '');
});
afterEach(() => vi.unstubAllEnvs());

function stubParts(overrides: Partial<Record<keyof typeof parts, string>> = {}) {
  for (const [name, value] of Object.entries({ ...parts, ...overrides })) vi.stubEnv(name, value);
}

it('prefers an explicit override over DATABASE_URL and the individual variables', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://env:env@env-host:5432/env');
  stubParts();
  expect(resolveDatabaseUrl('postgresql://a:b@override:5432/db')).toBe('postgresql://a:b@override:5432/db');
});
it('uses DATABASE_URL when no override is given', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://env:env@env-host:5432/env');
  stubParts();
  expect(resolveDatabaseUrl()).toBe('postgresql://env:env@env-host:5432/env');
});
it('falls back to DATABASE_URL when the override is an empty string', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://env:env@env-host:5432/env');
  expect(resolveDatabaseUrl('')).toBe('postgresql://env:env@env-host:5432/env');
});
it('rewrites the SQLAlchemy postgresql+psycopg scheme to postgresql', () => {
  expect(resolveDatabaseUrl('postgresql+psycopg://u:p@host:5432/db')).toBe('postgresql://u:p@host:5432/db');
  vi.stubEnv('DATABASE_URL', 'postgresql+psycopg://u:p@env-host:5432/db');
  expect(resolveDatabaseUrl()).toBe('postgresql://u:p@env-host:5432/db');
});
it('builds the URL from the individual variables when no URL is configured', () => {
  stubParts();
  expect(resolveDatabaseUrl()).toBe('postgresql://taskly:secret@db.internal:5433/tasks');
});
it('percent-encodes special characters in credentials and database name', () => {
  stubParts({ POSTGRES_USER: 'user@corp', POSTGRES_PASSWORD: 'p@ss:w/rd', POSTGRES_DB: 'my db' });
  expect(resolveDatabaseUrl()).toBe('postgresql://user%40corp:p%40ss%3Aw%2Frd@db.internal:5433/my%20db');
});
it.each(Object.keys(parts))('throws when %s is missing and no URL is configured', (name) => {
  stubParts({ [name]: '' });
  expect(() => resolveDatabaseUrl()).toThrow(`Missing environment variable: ${name}`);
});

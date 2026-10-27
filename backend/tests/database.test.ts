import { it, expect, vi } from 'vitest';
import { createDatabase, initialize } from '../src/core/database.ts';
import type { Database } from '../src/features/todos/types.ts';

it('creates a Prisma client exposing the todo delegate without connecting', () => {
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  expect(typeof database.todo.findMany).toBe('function');
  expect(typeof database.$connect).toBe('function');
});
it('creates the todos table idempotently with the SQLAlchemy-compatible schema', async () => {
  const $executeRaw = vi.fn().mockResolvedValue(0);
  await initialize({ $executeRaw } as unknown as Database);
  expect($executeRaw).toHaveBeenCalledOnce();
  const call = $executeRaw.mock.calls[0];
  expect(call).toHaveLength(1);
  const sql = (call[0] as TemplateStringsArray).join('');
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS todos');
  expect(sql).toContain('id SERIAL PRIMARY KEY');
  expect(sql).toContain('title VARCHAR(120) NOT NULL CONSTRAINT todo_title_not_empty CHECK (length(title) >= 1)');
  expect(sql).toContain("description VARCHAR(2000) NOT NULL DEFAULT ''");
  expect(sql).toContain("priority VARCHAR(6) NOT NULL DEFAULT 'medium' CONSTRAINT todo_priority CHECK (priority IN ('low', 'medium', 'high'))");
  expect(sql).toContain('due_date DATE,');
  expect(sql).toContain('completed BOOLEAN NOT NULL DEFAULT FALSE');
  expect(sql).toContain('created_at TIMESTAMPTZ NOT NULL');
  expect(sql).toContain('updated_at TIMESTAMPTZ NOT NULL');
});
it('propagates errors from the database while initializing', async () => {
  const $executeRaw = vi.fn().mockRejectedValue(new Error('permission denied'));
  await expect(initialize({ $executeRaw } as unknown as Database)).rejects.toThrow('permission denied');
});

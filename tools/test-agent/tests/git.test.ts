import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { changedFiles, fileDiff, isGitRepository, parseNameStatus } from '../src/git.ts';
import { runCommand } from '../src/process.ts';
import { tempRepo } from './helpers.ts';

async function git(root: string, ...args: string[]) {
  const result = await runCommand('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

it('parses name-status output with renames', () => {
  expect(parseNameStatus('M\0a.ts\0A\0b.ts\0D\0c.ts\0R087\0old.ts\0new.ts\0')).toEqual([
    { path: 'a.ts', status: 'modified' },
    { path: 'b.ts', status: 'added' },
    { path: 'c.ts', status: 'deleted' },
    { path: 'new.ts', status: 'renamed' },
  ]);
});

it('lists pull request changes against the merge base', async () => {
  const root = await tempRepo({ 'backend/src/a.ts': 'export const a = 1;\n', 'backend/src/b.ts': 'export const b = 1;\n' });
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'base');
  const base = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'checkout', '-qb', 'feature');
  await writeFile(path.join(root, 'backend/src/a.ts'), 'export const a = 2;\n');
  await rm(path.join(root, 'backend/src/b.ts'));
  await writeFile(path.join(root, 'backend/src/c.ts'), 'export const c = 1;\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-qm', 'feature');

  expect(await isGitRepository(root)).toBe(true);
  expect(await changedFiles(root, base, 'HEAD')).toEqual([
    { path: 'backend/src/a.ts', status: 'modified' },
    { path: 'backend/src/b.ts', status: 'deleted' },
    { path: 'backend/src/c.ts', status: 'added' },
  ]);
  expect(await fileDiff(root, base, 'HEAD', 'backend/src/a.ts')).toContain('+export const a = 2;');
});

it('rejects refs that could be read as options', async () => {
  const root = await tempRepo();
  await expect(changedFiles(root, '--output=/tmp/x', 'HEAD')).rejects.toThrow('Invalid git ref');
  await expect(changedFiles(root, 'main; rm -rf /', 'HEAD')).rejects.toThrow('Invalid git ref');
});

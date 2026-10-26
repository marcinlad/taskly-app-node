import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGES } from '../src/config.ts';
import { isReadable, isTestableSource, isTestFile, normalizeRepoPath, packageOf, resolveInsideRoot, toRepoRelative } from '../src/paths.ts';
import { tempRepo } from './helpers.ts';

const { backend, frontend } = PACKAGES;

describe('normalizeRepoPath', () => {
  it.each([
    ['backend/tests/a.test.ts', 'backend/tests/a.test.ts'],
    ['./backend/tests/../tests/a.test.ts', 'backend/tests/a.test.ts'],
    ['frontend/src/', 'frontend/src'],
    ['.', '.'],
  ])('normalizes %s', (input, expected) => expect(normalizeRepoPath(input)).toBe(expected));

  it.each(['/etc/passwd', '../outside', 'backend/../../outside', 'a\\b', 'a\0b', '', 'x'.repeat(501)])('rejects %j', (input) => {
    expect(normalizeRepoPath(input)).toBeNull();
  });
});

describe('access rules', () => {
  it.each(['.env', 'backend/.env.local', 'frontend/.npmrc', 'certs/server.pem', 'node_modules/x/index.js', 'backend/node_modules/a.ts', '.git/config', 'frontend/coverage/index.html', 'backend/src/generated/prisma/client.ts'])(
    'hides %s from the agent', (file) => expect(isReadable(file)).toBe(false),
  );

  it.each(['backend/src/factory.ts', 'backend/prisma/schema.prisma', 'README.md', 'frontend/src/lib/http.ts'])('lets the agent read %s', (file) => {
    expect(isReadable(file)).toBe(true);
  });

  it('allows writing only test files of the session package', () => {
    expect(isTestFile('backend/tests/factory.test.ts', backend)).toBe(true);
    expect(isTestFile('backend/tests/fixture.ts', backend)).toBe(false);
    expect(isTestFile('backend/src/factory.ts', backend)).toBe(false);
    expect(isTestFile('backend/vitest.config.ts', backend)).toBe(false);
    expect(isTestFile('frontend/src/lib/http.test.ts', backend)).toBe(false);
    expect(isTestFile('frontend/src/lib/http.test.ts', frontend)).toBe(true);
    expect(isTestFile('frontend/src/features/todos/A.test.tsx', frontend)).toBe(true);
    expect(isTestFile('frontend/src/test/todoFixture.ts', frontend)).toBe(false);
    expect(isTestFile('frontend/src/test/setup.ts', frontend)).toBe(false);
    expect(isTestFile('frontend/src/lib/http.ts', frontend)).toBe(false);
    expect(isTestFile('frontend/src/node_modules/x.test.ts', frontend)).toBe(false);
  });

  it('mirrors the coverage exclusions of each package', () => {
    expect(isTestableSource('backend/src/features/todos/router.ts', backend)).toBe(true);
    expect(isTestableSource('backend/src/features/todos/types.ts', backend)).toBe(false);
    expect(isTestableSource('frontend/src/lib/http.ts', frontend)).toBe(true);
    for (const file of ['frontend/src/main.tsx', 'frontend/src/design-system/components/Button/Button.tsx', 'frontend/src/features/todos/index.ts', 'frontend/src/lib/queryClient.ts', 'frontend/src/a.test.tsx', 'frontend/src/styles.css']) {
      expect(isTestableSource(file, frontend), file).toBe(false);
    }
  });

  it('maps paths to packages', () => {
    expect(packageOf('backend/src/main.ts')).toBe('backend');
    expect(packageOf('frontend/index.html')).toBe('frontend');
    expect(packageOf('README.md')).toBeNull();
    expect(packageOf('backend-tools/x.ts')).toBeNull();
  });
});

describe('resolveInsideRoot', () => {
  it('resolves existing and new paths inside the root', async () => {
    const root = await tempRepo({ 'backend/tests/a.test.ts': '' });
    expect(await resolveInsideRoot(root, 'backend/tests/a.test.ts')).toBe(path.join(root, 'backend/tests/a.test.ts'));
    expect(await resolveInsideRoot(root, 'backend/tests/new/b.test.ts')).toBe(path.join(root, 'backend/tests/new/b.test.ts'));
  });

  it('rejects a symlinked directory that points outside the root', async () => {
    const outside = await tempRepo();
    const root = await tempRepo();
    await mkdir(path.join(root, 'backend'), { recursive: true });
    await symlink(outside, path.join(root, 'backend/tests'));
    await expect(resolveInsideRoot(root, 'backend/tests/a.test.ts')).rejects.toThrow('escapes the repository');
  });

  it('refuses to follow a symlink at the target', async () => {
    const root = await tempRepo({ 'backend/tests/real.ts': '' });
    await symlink(path.join(root, 'backend/tests/real.ts'), path.join(root, 'backend/tests/link.test.ts'));
    await expect(resolveInsideRoot(root, 'backend/tests/link.test.ts')).rejects.toThrow('symlink');
  });
});

it('converts host and sandbox paths to repository paths', () => {
  expect(toRepoRelative('/work/repo/backend/tests/a.test.ts', '/work/repo')).toBe('backend/tests/a.test.ts');
  expect(toRepoRelative('/repo/frontend/src/a.ts', '/work/repo')).toBe('frontend/src/a.ts');
});

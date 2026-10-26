import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isReadable } from './paths.ts';

/** Lists readable files under `dirRel`, sorted, as repository-relative POSIX paths. */
export async function walkFiles(repoRoot: string, dirRel: string, limit = 5_000): Promise<string[]> {
  const found: string[] = [];
  async function visit(rel: string): Promise<void> {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = await readdir(path.join(repoRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
      if (!isReadable(child)) continue;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) found.push(child);
      if (found.length >= limit) return;
    }
  }
  await visit(dirRel);
  return found;
}

const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g;
const MOCK_SPECIFIER = /vi\.mock\(\s*['"]([^'"]+)['"]/g;

/** Relative module specifiers resolved to repo paths without extension. */
function resolveSpecifiers(fileRel: string, source: string, pattern: RegExp): Set<string> {
  const dir = path.posix.dirname(fileRel);
  const modules = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    modules.add(stripExtension(path.posix.normalize(path.posix.join(dir, specifier))));
  }
  return modules;
}

/**
 * Modules a test file exercises: those it imports and does not replace with `vi.mock`. A test
 * that mocks a module imports it only to drive the mock, so it does not test that module.
 */
export function testedModules(fileRel: string, source: string): string[] {
  const mocked = resolveSpecifiers(fileRel, source, MOCK_SPECIFIER);
  return [...resolveSpecifiers(fileRel, source, IMPORT_SPECIFIER)].filter((module) => !mocked.has(module));
}

export function stripExtension(file: string): string {
  return file.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
}

/** Test files that import `sourceRel` without mocking it. */
export async function findRelatedTests(repoRoot: string, testFiles: string[], sourceRel: string): Promise<string[]> {
  const target = stripExtension(sourceRel);
  const related: string[] = [];
  for (const testFile of testFiles) {
    const content = await readFile(path.join(repoRoot, testFile), 'utf8').catch(() => '');
    if (testedModules(testFile, content).includes(target)) related.push(testFile);
  }
  return related;
}

import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGES, type PackageConfig, type PackageName } from './config.ts';

const HIDDEN_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'coverage', 'storybook-static', 'generated', '.vite']);

const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519).*)$/i;

// A lexical check; anything that touches the disk also goes through resolveInsideRoot.
export function normalizeRepoPath(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 500) return null;
  if (input.includes('\0') || input.includes('\\')) return null;
  if (path.posix.isAbsolute(input)) return null;
  const normalized = path.posix.normalize(input).replace(/^\.\//, '').replace(/\/$/, '');
  if (normalized === '.' || normalized === '') return '.';
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export function isHidden(relPath: string): boolean {
  return relPath.split('/').some((segment) => HIDDEN_SEGMENTS.has(segment));
}

export function isSecretFile(relPath: string): boolean {
  return SECRET_FILE.test(relPath);
}

export function isReadable(relPath: string): boolean {
  return !isHidden(relPath) && !isSecretFile(relPath);
}

export function packageOf(relPath: string): PackageName | null {
  for (const pkg of Object.values(PACKAGES)) {
    if (relPath.startsWith(`${pkg.dir}/`)) return pkg.name;
  }
  return null;
}

export function isTestFile(relPath: string, pkg: PackageConfig): boolean {
  return pkg.testFilePattern.test(relPath) && !isHidden(relPath);
}

export function isTestableSource(relPath: string, pkg: PackageConfig): boolean {
  return pkg.sourcePattern.test(relPath) && !pkg.sourceExclude.some((re) => re.test(relPath));
}

// Follows symlinks of parent directories and refuses one at the target, so a write can't be redirected.
export async function resolveInsideRoot(root: string, relPath: string): Promise<string> {
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, relPath);
  let probe = absolute;
  while (true) {
    try {
      const stats = await lstat(probe);
      if (probe === absolute && stats.isSymbolicLink()) throw new Error(`Refusing to follow a symlink: ${relPath}`);
      const real = await realpath(probe);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`Path escapes the repository: ${relPath}`);
      return absolute;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error(`Path escapes the repository: ${relPath}`);
      probe = parent;
    }
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function toRepoRelative(absolute: string, repoRoot: string): string {
  for (const root of [repoRoot, '/repo']) {
    const rel = path.relative(root, absolute);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  }
  return absolute;
}

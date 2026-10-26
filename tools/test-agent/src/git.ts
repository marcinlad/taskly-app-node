import { runCommand } from './process.ts';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  previousPath?: string;
}

const GIT_TIMEOUT_MS = 60_000;
/** Refs come from workflow inputs; accept SHAs and ordinary ref names only. */
const SAFE_REF = /^[\w./@{}~^-]{1,200}$/;

async function git(repoRoot: string, args: string[]): Promise<string> {
  const result = await runCommand('git', args, { cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function assertRef(ref: string): void {
  if (!SAFE_REF.test(ref) || ref.startsWith('-')) throw new Error(`Invalid git ref: ${ref}`);
}

export async function isGitRepository(repoRoot: string): Promise<boolean> {
  const result = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS });
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

/** Files changed between the merge base of `base` and `head`, as a pull request shows them. */
export async function changedFiles(repoRoot: string, base: string, head: string): Promise<ChangedFile[]> {
  assertRef(base);
  assertRef(head);
  const output = await git(repoRoot, ['diff', '--name-status', '-M', '-z', `${base}...${head}`, '--']);
  return parseNameStatus(output);
}

/** Parses `git diff --name-status -z` output. */
export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split('\0').filter((field) => field.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++];
    if (code.startsWith('R') || code.startsWith('C')) {
      const previousPath = fields[i++];
      const path = fields[i++];
      files.push({ path, previousPath, status: code.startsWith('R') ? 'renamed' : 'added' });
    } else {
      const path = fields[i++];
      const status: ChangeStatus = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
      files.push({ path, status });
    }
  }
  return files;
}

export async function fileDiff(repoRoot: string, base: string, head: string, file: string): Promise<string> {
  assertRef(base);
  assertRef(head);
  return git(repoRoot, ['diff', '--unified=5', '--no-color', `${base}...${head}`, '--', file]);
}

/** Paths with uncommitted changes (modified, added or untracked) in the working tree. */
export async function dirtyPaths(repoRoot: string): Promise<string[]> {
  const output = await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const fields = output.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    paths.push(entry.slice(3));
    // A rename lists the original path as the next field.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return paths;
}

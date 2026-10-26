import { runCommand } from './process.ts';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  previousPath?: string;
}

const GIT_TIMEOUT_MS = 60_000;
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

export async function changedFiles(repoRoot: string, base: string, head: string): Promise<ChangedFile[]> {
  assertRef(base);
  assertRef(head);
  const output = await git(repoRoot, ['diff', '--name-status', '-M', '-z', `${base}...${head}`, '--']);
  return parseNameStatus(output);
}

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

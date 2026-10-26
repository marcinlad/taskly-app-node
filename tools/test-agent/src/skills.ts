import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Skill {
  name: string;
  description: string;
  body: string;
}

/**
 * Skills use the Agent Skills layout (`<name>/SKILL.md` with `name` and `description` frontmatter),
 * so the same files also work as Claude Code skills.
 */
export async function loadSkills(dir: string): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const skill = parseSkill(await readFile(path.join(dir, entry.name, 'SKILL.md'), 'utf8'));
    if (skill.name !== entry.name) throw new Error(`Skill ${entry.name}: frontmatter name is "${skill.name}"`);
    skills.set(skill.name, skill);
  }
  return skills;
}

export function parseSkill(content: string): Skill {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) throw new Error('SKILL.md must start with a frontmatter block');
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const field = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].replace(/^["']|["']$/g, '').trim();
  }
  if (!fields.name || !fields.description) throw new Error('SKILL.md frontmatter needs name and description');
  return { name: fields.name, description: fields.description, body: match[2].trim() };
}

/** The list the system prompt shows; the agent loads a skill's body with `load_skill`. */
export function skillIndex(skills: Skill[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
}

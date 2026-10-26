import { expect, it } from 'vitest';
import { PACKAGES, SHARED_SKILLS, SKILLS_DIR } from '../src/config.ts';
import { loadSkills, parseSkill, skillIndex } from '../src/skills.ts';

it('parses frontmatter and body', () => {
  expect(parseSkill('---\nname: demo\ndescription: "Does a thing."\n---\n\n# Body\n')).toEqual({ name: 'demo', description: 'Does a thing.', body: '# Body' });
});

it.each(['# No frontmatter', '---\nname: demo\n---\nbody'])('rejects an invalid skill: %j', (content) => {
  expect(() => parseSkill(content)).toThrow();
});

it('ships every skill the agent recommends, with matching names', async () => {
  const skills = await loadSkills(SKILLS_DIR);
  const referenced = [...SHARED_SKILLS, 'pr-change-analysis', 'failure-triage', ...Object.values(PACKAGES).flatMap((pkg) => pkg.skills)];
  for (const name of referenced) expect(skills.has(name), name).toBe(true);
  for (const skill of skills.values()) {
    expect(skill.description.length, skill.name).toBeGreaterThan(30);
    expect(skill.body.length, skill.name).toBeGreaterThan(200);
  }
  expect(skillIndex([...skills.values()])).toContain('- backend-vitest: ');
});

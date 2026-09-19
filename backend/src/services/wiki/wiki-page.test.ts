import { parsePage, serializePage, checkRetention, indexLineFor, isVisibleTo, oneLine } from './wiki-page.js';

describe('wiki-page', () => {
  it('parses and re-serialises frontmatter in canonical key order', () => {
    const raw = '---\ntags:\n  - a\ntitle: Pricing\nsummary: We charge 800\nkeep_because: hard_fact\n---\n# Pricing\n\nBody';
    const page = parsePage(raw);
    expect(page.hadFrontmatter).toBe(true);
    expect(page.frontmatter).toEqual({ tags: ['a'], title: 'Pricing', summary: 'We charge 800', keep_because: 'hard_fact' });
    const out = serializePage(page.frontmatter, page.body);
    expect(out.startsWith('---\ntitle: Pricing\nsummary: We charge 800\nkeep_because: hard_fact\ntags:\n  - a\n---\n# Pricing')).toBe(true);
  });

  it('treats a page without (or with broken) frontmatter as body-only', () => {
    expect(parsePage('# Just text').hadFrontmatter).toBe(false);
    expect(parsePage('---\n: bad: [\n---\nx').hadFrontmatter).toBe(false);
  });

  it('retention gate: refuses without title/summary/keep_because and names what is missing', () => {
    const refusal = checkRetention({ title: 'x' });
    expect(refusal?.reason).toBe('retention_gate');
    expect(refusal?.missing).toEqual(['summary', expect.stringContaining('keep_because')]);
    expect(refusal?.message).toContain('log.md');
    expect(checkRetention({ title: 'x', summary: 'y', keep_because: 'nope' as never })?.missing).toEqual([expect.stringContaining('keep_because')]);
    expect(checkRetention({ title: 'x', summary: 'y'.repeat(300), keep_because: 'hard_fact' })?.missing[0]).toContain('summary');
    expect(checkRetention({ title: 'x', summary: 'y', keep_because: 'reusable_method' })).toBeNull();
  });

  it('builds an index line and marks supersession', () => {
    expect(indexLineFor('llm-curated/decisions/p.md', { title: 'Pricing', summary: 'We charge 800' })).toBe(
      '- [Pricing](llm-curated/decisions/p.md) — We charge 800',
    );
    expect(indexLineFor('a/b.md', { title: 'Old', summary: 's', superseded_by: 'a/c.md' })).toContain('⟶ superseded by a/c.md');
    expect(indexLineFor('a/b.md', {})).toBe('- [b.md](a/b.md)');
  });

  it('visibility: absent = public; listed roles + orchestrator/owner may read', () => {
    expect(isVisibleTo({}, 'parent')).toBe(true);
    expect(isVisibleTo({ visibility: ['teacher', 'admin'] }, 'parent')).toBe(false);
    expect(isVisibleTo({ visibility: ['teacher'] }, 'Teacher')).toBe(true);
    expect(isVisibleTo({ visibility: ['teacher'] }, 'orchestrator')).toBe(true);
    expect(isVisibleTo({ visibility: ['teacher'] }, undefined)).toBe(true);
  });

  it('oneLine unescapes literal \\n and truncates', () => {
    expect(oneLine('a\\n\\nb   c', 100)).toBe('a b c');
    expect(oneLine('x'.repeat(10), 5)).toBe('xxxx…');
  });
});

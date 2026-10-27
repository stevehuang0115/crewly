/**
 * Tests for the outbound tools list (crewly#894): every write-shaped bundled
 * skill is classified, every listed skill exists, and the helpers answer.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import {
  isOutboundTool,
  listOutboundTools,
  NOT_OUTBOUND,
  OUTBOUND_GATES,
  OUTBOUND_TOOLS,
  outboundGateOf,
  WRITE_SHAPED_SKILL,
} from './outbound-tools.js';

/** `config/skills/agent` of this checkout. */
const SKILLS_DIR = resolve(__dirname, '..', '..', '..', '..', 'config', 'skills', 'agent');

/**
 * Bundled skill names as agents call them: `core/<x>` is `<x>`, a top-level
 * directory is its own name, any other group keeps its prefix
 * (`marketplace/gmail`).
 *
 * @param dir - Directory to walk
 * @returns Skill names, sorted
 */
function bundledSkills(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'SKILL.md') out.push(relative(dir, d).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.map((p) => (p.startsWith('core/') ? p.slice('core/'.length) : p)).sort();
}

const skills = bundledSkills(SKILLS_DIR);
const listed = new Set(OUTBOUND_TOOLS.map((t) => t.skill));
const notOutbound = new Set(Object.keys(NOT_OUTBOUND));

describe('OUTBOUND_TOOLS', () => {
  it('finds the bundled skills (zero is a failure, not a pass)', () => {
    expect(existsSync(SKILLS_DIR)).toBe(true);
    expect(skills.length).toBeGreaterThan(50);
    expect(skills).toContain('gmail-send');
    expect(skills).toContain('marketplace/gmail');
  });

  it('lists only skills that exist, once each, with a valid gate and a note for the owner', () => {
    const gates = new Set<string>(Object.values(OUTBOUND_GATES));
    expect(OUTBOUND_TOOLS.filter((t) => !skills.includes(t.skill)).map((t) => t.skill)).toEqual([]);
    expect(listed.size).toBe(OUTBOUND_TOOLS.length);
    expect(OUTBOUND_TOOLS.filter((t) => !gates.has(t.gate)).map((t) => t.skill)).toEqual([]);
    expect(OUTBOUND_TOOLS.filter((t) => t.note.trim().length < 20 || !t.surface.trim()).map((t) => t.skill)).toEqual([]);
  });

  it('keeps NOT_OUTBOUND to skills that exist, with a reason, and never on both lists', () => {
    expect([...notOutbound].filter((s) => !skills.includes(s))).toEqual([]);
    expect(Object.entries(NOT_OUTBOUND).filter(([, why]) => why.trim().length < 10).map(([s]) => s)).toEqual([]);
    expect([...notOutbound].filter((s) => listed.has(s))).toEqual([]);
  });

  it('classifies every write-shaped bundled skill (a new *-send / *-post / *-create skill must be placed)', () => {
    const unplaced = skills.filter((s) => WRITE_SHAPED_SKILL.test(s) && !listed.has(s) && !notOutbound.has(s));
    expect(unplaced).toEqual([]);
  });

  it('matches the shapes it is meant to, and not code-identifier look-alikes', () => {
    for (const s of ['gmail-send', 'slack-post', 'publish-app', 'create-task', 'marketplace/social-media-post', 'reply', 'todo-add', 'canva-export']) {
      expect(WRITE_SHAPED_SKILL.test(s)).toBe(true);
    }
    for (const s of ['content-writer', 'dep-updater', 'remember', 'seo-blog-writer', 'readme-generator', 'get-sops']) {
      expect(WRITE_SHAPED_SKILL.test(s)).toBe(false);
    }
  });

  it('holds every mail and messaging send: a draft or the owner\'s word, never nothing', () => {
    for (const skill of ['gmail-send', 'marketplace/gmail', 'zoho-draft', 'whatsapp-draft', 'whatsapp-send', 'docs-comment']) {
      expect([OUTBOUND_GATES.DRAFT, OUTBOUND_GATES.OWNER_WORD]).toContain(outboundGateOf(skill));
    }
    expect(outboundGateOf('remote-browser')).toBe(OUTBOUND_GATES.OWNER_CARD);
  });

  it('answers the helpers', () => {
    expect(isOutboundTool('gmail-send')).toBe(true);
    expect(isOutboundTool('reply')).toBe(false);
    expect(isOutboundTool('no-such-skill')).toBe(false);
    expect(outboundGateOf('reply')).toBeNull();
    const list = listOutboundTools();
    expect(list).toEqual(OUTBOUND_TOOLS);
    list[0].note = 'changed';
    expect(OUTBOUND_TOOLS[0].note).not.toBe('changed');
  });
});

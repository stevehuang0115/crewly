/**
 * Tests for the project ticket file format: parse, render, and in-place
 * edits that preserve human changes byte-for-byte.
 */
import {
  applyTicketChanges,
  formatLogLine,
  parseTicketFile,
  renderCriteria,
  renderNewTicketFile,
  slugifyTitle,
} from './ticket-file.js';
import type { ProjectTicketFields } from '../../types/project-ticket.types.js';

const FIELDS: ProjectTicketFields = {
  id: 'CRW-12',
  title: 'Export the report as CSV',
  status: 'ready',
  priority: 'P1',
  assignee: null,
  team: null,
  labels: ['export'],
  ownerReview: false,
  createdAt: '2026-09-28T10:00:00.000Z',
  updatedAt: '2026-09-28T10:00:00.000Z',
  workItemId: null,
  requestId: null,
  source: 'owner',
  migratedFrom: null,
};

function newFile(): string {
  return renderNewTicketFile({
    fields: FIELDS,
    description: 'Owners want a CSV.',
    acceptance: [{ text: 'A header row is present', done: false }],
    logLines: ['2026-09-28T10:00:00.000Z · owner · created'],
  });
}

describe('renderNewTicketFile + parseTicketFile', () => {
  it('round-trips every owned field and the sections', () => {
    const parsed = parseTicketFile(newFile());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.fields).toEqual(FIELDS);
    expect(parsed.file.description).toBe('Owners want a CSV.');
    expect(parsed.file.acceptance).toEqual([{ text: 'A header row is present', done: false }]);
    expect(parsed.file.log).toEqual(['2026-09-28T10:00:00.000Z · owner · created']);
    expect(parsed.file.extra).toEqual({});
  });

  it('writes labels in flow style and omits an empty migratedFrom', () => {
    const text = newFile();
    expect(text).toContain('labels: [ export ]');
    expect(text).not.toContain('migratedFrom');
    expect(text.startsWith('---\nid: CRW-12\n')).toBe(true);
  });
});

describe('parseTicketFile tolerance', () => {
  it.each([
    ['no frontmatter', '# just a note\n', 'missing YAML frontmatter'],
    ['bad yaml', '---\nid: [oops\n---\nbody\n', 'invalid YAML'],
    ['not a mapping', '---\n- a\n- b\n---\n', 'mapping'],
    ['bad id', '---\nid: twelve\ntitle: x\nstatus: ready\n---\n', 'id must'],
    ['no title', '---\nid: A-1\nstatus: ready\n---\n', 'title is required'],
    ['bad status', '---\nid: A-1\ntitle: x\nstatus: open\n---\n', 'status must'],
    ['bad priority', '---\nid: A-1\ntitle: x\nstatus: ready\npriority: P9\n---\n', 'priority must'],
  ])('%s → error, never a throw', (_name, text, want) => {
    const r = parseTicketFile(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(want);
  });

  it('accepts hand-written variants: word priorities, comma labels, missing optional fields, CRLF', () => {
    const r = parseTicketFile('---\r\nid: A-3\r\ntitle: Hand written\r\nstatus: backlog\r\npriority: high\r\nlabels: ui, bug\r\n---\r\nfree text\r\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.fields.priority).toBe('P1');
    expect(r.file.fields.labels).toEqual(['ui', 'bug']);
    expect(r.file.fields.assignee).toBeNull();
    expect(r.file.log).toEqual([]);
  });

  it('keeps unknown frontmatter keys in extra', () => {
    const r = parseTicketFile('---\nid: A-4\ntitle: t\nstatus: ready\nestimate: 3h\n---\n');
    expect(r.ok && r.file.extra).toEqual({ estimate: '3h' });
  });

  it('ignores headings inside fenced code blocks', () => {
    const text = `---\nid: A-5\ntitle: t\nstatus: ready\n---\n\n## Description\n\n\`\`\`\n## Log\n- not a log\n\`\`\`\n\n## Log\n\n- real\n`;
    const r = parseTicketFile(text);
    expect(r.ok && r.file.log).toEqual(['real']);
  });
});

describe('applyTicketChanges preserves human edits', () => {
  const HUMAN = [
    '---',
    '# a human comment',
    'id: CRW-12',
    'title: "Export the report as CSV"',
    'status: ready',
    'priority: P1',
    'estimate: 3h   # kept',
    '---',
    '',
    'Intro paragraph a human wrote.',
    '',
    '## Description',
    '',
    'Owners want a CSV.   ',
    '',
    '## Notes from the owner',
    '',
    '* keep this *exactly*',
    '',
    '## Log',
    '',
    '- 2026-09-28T10:00:00.000Z · owner · created',
    '',
    '## Appendix',
    '',
    'after the log',
    '',
  ].join('\n');

  it('changes only owned keys, keeps comments / unknown keys / quoting', () => {
    const out = applyTicketChanges(HUMAN, { fields: { status: 'in_progress', assignee: 'dev-1' } });
    expect(out).toContain('# a human comment');
    expect(out).toMatch(/estimate: 3h +# kept/);
    expect(out).toContain('title: "Export the report as CSV"');
    expect(out).toContain('status: in_progress');
    expect(out).toContain('assignee: dev-1');
    // body untouched byte-for-byte
    expect(out.slice(out.indexOf('\nIntro'))).toBe(HUMAN.slice(HUMAN.indexOf('\nIntro')));
  });

  it('returns the identical string when nothing changes', () => {
    expect(applyTicketChanges(HUMAN, { fields: { status: 'ready', priority: 'P1' } })).toBe(HUMAN);
    expect(applyTicketChanges(HUMAN, {})).toBe(HUMAN);
  });

  it('appends to the Log section in place, before a later section', () => {
    const out = applyTicketChanges(HUMAN, { logLines: ['2026-09-28T11:00:00.000Z · dev-1 · claimed'] });
    expect(out).toContain('- 2026-09-28T10:00:00.000Z · owner · created\n- 2026-09-28T11:00:00.000Z · dev-1 · claimed\n\n## Appendix');
    const r = parseTicketFile(out);
    expect(r.ok && r.file.log).toHaveLength(2);
    // everything before the Log stays identical
    const cut = HUMAN.indexOf('- 2026-09-28T10');
    expect(out.slice(0, cut)).toBe(HUMAN.slice(0, cut));
  });

  it('creates a Log section when a human removed it', () => {
    const noLog = '---\nid: A-1\ntitle: t\nstatus: ready\n---\nbody without sections';
    const out = applyTicketChanges(noLog, { logLines: ['x · owner · hi'] });
    expect(out).toBe('---\nid: A-1\ntitle: t\nstatus: ready\n---\nbody without sections\n\n## Log\n\n- x · owner · hi\n');
  });

  it('fills an empty Log section', () => {
    const empty = '---\nid: A-1\ntitle: t\nstatus: ready\n---\n\n## Log\n';
    expect(applyTicketChanges(empty, { logLines: ['a'] })).toBe('---\nid: A-1\ntitle: t\nstatus: ready\n---\n\n## Log\n\n- a\n');
  });

  it('replaces Description and Acceptance only when asked, keeping other sections', () => {
    const out = applyTicketChanges(HUMAN, {
      description: 'New words.',
      acceptance: [{ text: 'opens in Excel', done: true }],
    });
    expect(out).toContain('## Description\n\nNew words.\n\n## Notes from the owner');
    expect(out).toContain('* keep this *exactly*');
    expect(out).toContain('## Acceptance criteria\n\n- [x] opens in Excel\n\n## Log');
  });

  it('keeps CRLF line endings', () => {
    const crlf = '---\r\nid: A-1\r\ntitle: t\r\nstatus: ready\r\n---\r\n\r\n## Log\r\n\r\n- a\r\n';
    const out = applyTicketChanges(crlf, { fields: { status: 'backlog' }, logLines: ['b'] });
    expect(out).toBe('---\r\nid: A-1\r\ntitle: t\r\nstatus: backlog\r\n---\r\n\r\n## Log\r\n\r\n- a\r\n- b\r\n');
  });

  it('throws on a file without frontmatter', () => {
    expect(() => applyTicketChanges('plain', { logLines: ['x'] })).toThrow('frontmatter');
  });
});

describe('helpers', () => {
  it('slugifies titles', () => {
    expect(slugifyTitle('Export the report as CSV!')).toBe('export-the-report-as-csv');
    expect(slugifyTitle('导出报表')).toBe('ticket');
    expect(slugifyTitle('Café déjà vu')).toBe('cafe-deja-vu');
    expect(slugifyTitle('x'.repeat(100)).length).toBeLessThanOrEqual(48);
  });

  it('formats log lines on one line', () => {
    expect(formatLogLine('dev-1', 'did\nthings', '2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z · dev-1 · did things');
  });

  it('renders criteria, with a placeholder when empty', () => {
    expect(renderCriteria([{ text: 'a', done: false }, { text: 'b', done: true }])).toBe('- [ ] a\n- [x] b');
    expect(renderCriteria([])).toBe('_None yet._');
  });
});

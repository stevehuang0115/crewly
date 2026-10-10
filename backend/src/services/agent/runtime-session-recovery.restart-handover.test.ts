/**
 * Tests for the restart handover: finding the previous Claude Code
 * conversation of a session, writing the handover, and chaining handovers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  chainedHandoverBlock,
  findPreviousClaudeConversation,
  latestHandoverFile,
  readLastConversation,
  rememberedConversationToResume,
  rememberLastConversation,
  writeRestartHandover,
} from './runtime-session-recovery.js';

const DAY = 24 * 60 * 60 * 1000;

describe('restart handover', () => {
  let root: string;
  let cwd: string;
  let claudeHome: string;
  let accountHome: string;
  let handoverDir: string;
  let projectDir: string;

  /** Write a transcript for a session, aged `ageMs`. */
  function transcript(home: string, id: string, ageMs: number, text = 'Plan the three videos', mention = 'pia'): string {
    const dir = path.join(home, 'projects', path.resolve(cwd).replace(/[/.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: `You are ${mention} (session: ${mention}).` } })}\n` +
        `${JSON.stringify({ type: 'user', timestamp: '2026-10-09T10:00:00Z', message: { role: 'user', content: text } })}\n` +
        `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Video one is the intro, two the demo.' }] } })}\n`,
    );
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
    return file;
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restart-handover-')));
    cwd = path.join(root, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    claudeHome = path.join(root, 'claude');
    accountHome = path.join(root, 'account');
    handoverDir = path.join(root, 'handover');
    projectDir = '';
    void projectDir;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('findPreviousClaudeConversation', () => {
    it('returns the newest transcript across the default and account homes', () => {
      transcript(claudeHome, 'old', 3 * DAY);
      transcript(accountHome, 'new', 1 * DAY);
      const found = findPreviousClaudeConversation({ cwd, claudeHomes: [accountHome, claudeHome], sessionName: 'pia' });
      expect(found?.sessionId).toBe('new');
    });

    it('ignores transcripts older than 7 days', () => {
      transcript(claudeHome, 'ancient', 8 * DAY);
      expect(findPreviousClaudeConversation({ cwd, claudeHomes: [claudeHome], sessionName: 'pia' })).toBeNull();
    });

    it('skips transcripts that belong to another session or are claimed by one', () => {
      transcript(claudeHome, 'someone-else', 1 * DAY, 'x', 'bob');
      transcript(claudeHome, 'claimed', 2 * DAY);
      const found = findPreviousClaudeConversation({
        cwd,
        claudeHomes: [claudeHome],
        sessionName: 'pia',
        claimedByOthers: new Set(['claimed']),
      });
      expect(found).toBeNull();
    });

    it('picks the newest transcript the session owns, not a bigger person-owned one that only mentions its name', () => {
      // The session's own conversation (Claude Code marks it with agentSetting).
      const own = transcript(claudeHome, 'own-latest', 2 * 60 * 60 * 1000);
      fs.writeFileSync(
        own,
        `${JSON.stringify({ type: 'agent-setting', agentSetting: 'pia', sessionId: 'own-latest' })}\n` + fs.readFileSync(own, 'utf-8'),
      );
      const t = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(own, t, t);
      // An older session of hers.
      transcript(claudeHome, 'own-older', 1 * DAY);
      // A person's own conversation in the same folder: larger, written more
      // recently, and it mentions "pia" later on, not in its first message.
      const human = transcript(claudeHome, 'human-big', 60 * 1000, 'x', 'someone');
      fs.appendFileSync(
        human,
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'what is pia doing?' } })}\n` + 'x'.repeat(200_000) + '\n',
      );
      const now = new Date(Date.now() - 60 * 1000);
      fs.utimesSync(human, now, now);
      const found = findPreviousClaudeConversation({ cwd, claudeHomes: [claudeHome], sessionName: 'pia' });
      expect(found?.sessionId).toBe('own-latest');
    });

    it('finds the remembered conversation under the cwd it last ran in', () => {
      const other = path.join(root, 'elsewhere');
      fs.mkdirSync(other, { recursive: true });
      const dir = path.join(claudeHome, 'projects', path.resolve(other).replace(/[/.]/g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'moved.jsonl'), '{"type":"user","message":{"content":"hi"}}\n');
      const found = findPreviousClaudeConversation({
        cwd,
        claudeHomes: [claudeHome],
        sessionName: 'pia',
        rememberedSessionId: 'moved',
        rememberedCwd: other,
      });
      expect(found?.sessionId).toBe('moved');
    });

    it('uses the remembered conversation id without the session-name check', () => {
      transcript(claudeHome, 'remembered', 1 * DAY, 'x', 'zzz');
      const found = findPreviousClaudeConversation({ cwd, claudeHomes: [claudeHome], sessionName: 'pia', rememberedSessionId: 'remembered' });
      expect(found?.sessionId).toBe('remembered');
    });
  });

  describe('writeRestartHandover', () => {
    it('writes a handover with the end of the conversation and a kickoff note', () => {
      transcript(claudeHome, 'conv-1', 1 * DAY);
      const out = writeRestartHandover({ sessionName: 'pia', cwd, claudeHomes: [claudeHome], handoverDir });
      expect(out).not.toBeNull();
      const text = fs.readFileSync(out!.file, 'utf-8');
      expect(path.basename(out!.file)).toMatch(/^pia-restart-/);
      expect(text).toContain('Plan the three videos');
      expect(text).toContain('Video one is the intro');
      expect(out!.note).toContain(out!.file);
      expect(out!.note).toContain('search-chat');
    });

    it('does nothing when there is no recent conversation', () => {
      expect(writeRestartHandover({ sessionName: 'pia', cwd, claudeHomes: [claudeHome], handoverDir })).toBeNull();
      expect(fs.existsSync(handoverDir)).toBe(false);
    });

    it('skips a deliberate fresh start whose own handover is newer than the transcript', () => {
      transcript(claudeHome, 'conv-1', 1 * DAY);
      fs.mkdirSync(handoverDir, { recursive: true });
      fs.writeFileSync(path.join(handoverDir, 'pia-2026-10-09T10-00-00-000Z.md'), '# Handover from your previous conversation\n');
      expect(writeRestartHandover({ sessionName: 'pia', cwd, claudeHomes: [claudeHome], handoverDir })).toBeNull();
    });

    it('finds the conversation through the remembered id after a stop', () => {
      transcript(claudeHome, 'conv-stop', 1 * DAY, 'Plan the three videos', 'nobody');
      const file = path.join(root, 'last-conversations.json');
      rememberLastConversation(file, 'pia', { sessionId: 'conv-stop', cwd, at: Date.now() });
      expect(readLastConversation(file, 'pia')?.sessionId).toBe('conv-stop');
      const out = writeRestartHandover({ sessionName: 'pia', cwd, claudeHomes: [claudeHome], handoverDir, lastConversationsFile: file });
      expect(out?.previousSessionId).toBe('conv-stop');
    });
  });

  describe('handover chaining helpers', () => {
    it('latestHandoverFile picks the newest file of that session only', () => {
      fs.mkdirSync(handoverDir, { recursive: true });
      const a = path.join(handoverDir, 'pia-runtime-switch-2026-10-01T00-00-00-000Z.md');
      const b = path.join(handoverDir, 'pia-restart-2026-10-02T00-00-00-000Z.md');
      const other = path.join(handoverDir, 'pia2-runtime-switch-2026-10-03T00-00-00-000Z.md');
      for (const f of [a, b, other]) fs.writeFileSync(f, 'x');
      fs.utimesSync(a, new Date(1000), new Date(1000));
      fs.utimesSync(b, new Date(2000), new Date(2000));
      expect(latestHandoverFile(handoverDir, 'pia')?.path).toBe(b);
      expect(latestHandoverFile(handoverDir, 'pia', b)?.path).toBe(a);
      expect(latestHandoverFile(handoverDir, 'nobody')).toBeNull();
    });

    it('chainedHandoverBlock embeds the earlier body and names its file', () => {
      fs.mkdirSync(handoverDir, { recursive: true });
      const f = path.join(handoverDir, 'pia-restart-x.md');
      fs.writeFileSync(f, '# Handover: restart\n\nThe three-video plan: intro, demo, wrap-up.\n');
      const block = chainedHandoverBlock({ path: f, mtimeMs: 1 });
      expect(block).toContain(f);
      expect(block).toContain('The three-video plan');
      expect(block).not.toContain('# Handover: restart');
      expect(chainedHandoverBlock(null)).toBe('');
    });
  });

  describe('rememberedConversationToResume', () => {
    it('returns the conversation a stop remembered, so the next start resumes it', () => {
      const file = path.join(root, 'last-conversations.json');
      rememberLastConversation(file, 'pia', { sessionId: 'conv-1', cwd, at: Date.now() });
      expect(rememberedConversationToResume({ file, sessionName: 'pia' })?.sessionId).toBe('conv-1');
    });

    it('ignores an entry another live session owns, an expired one, and a missing file', () => {
      const file = path.join(root, 'last-conversations.json');
      rememberLastConversation(file, 'pia', { sessionId: 'conv-1', cwd, at: Date.now() });
      expect(rememberedConversationToResume({ file, sessionName: 'pia', claimedByOthers: new Set(['conv-1']) })).toBeNull();
      expect(rememberedConversationToResume({ file, sessionName: 'pia', now: Date.now() + 8 * DAY })).toBeNull();
      expect(rememberedConversationToResume({ file: path.join(root, 'nope.json'), sessionName: 'pia' })).toBeNull();
    });
  });
});

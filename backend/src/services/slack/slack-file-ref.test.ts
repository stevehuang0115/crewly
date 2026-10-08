/**
 * Tests for Slack file reference parsing.
 *
 * @module services/slack/slack-file-ref.test
 */

import { findSlackFileLinks, isSlackDownloadHost, isTextFile, parseSlackFileRef } from './slack-file-ref.js';

describe('parseSlackFileRef', () => {
  it('accepts a bare file id', () => {
    expect(parseSlackFileRef('F0ABC12345')).toEqual({ fileId: 'F0ABC12345' });
    expect(parseSlackFileRef('  F0ABC12345 ')).toEqual({ fileId: 'F0ABC12345' });
  });

  it('parses a workspace file permalink with uploader and host', () => {
    expect(parseSlackFileRef('https://acme.slack.com/files/U0ELLA1234/F0ABC12345/longform-en.md')).toEqual({
      fileId: 'F0ABC12345',
      uploaderUserId: 'U0ELLA1234',
      workspaceHost: 'acme.slack.com',
    });
  });

  it('parses a permalink without a name and with origin_team', () => {
    expect(parseSlackFileRef('https://acme.slack.com/files/U0ELLA1234/F0ABC12345?origin_team=T0ACME1234')).toEqual({
      fileId: 'F0ABC12345',
      uploaderUserId: 'U0ELLA1234',
      workspaceHost: 'acme.slack.com',
      slackTeamId: 'T0ACME1234',
    });
  });

  it('parses files-pri and files-tmb download URLs (team embedded)', () => {
    expect(parseSlackFileRef('https://files.slack.com/files-pri/T0ACME1234-F0ABC12345/longform-en.md')).toEqual({
      slackTeamId: 'T0ACME1234',
      fileId: 'F0ABC12345',
    });
    expect(parseSlackFileRef('https://files.slack.com/files-pri/T0ACME1234-F0ABC12345/download/longform-en.md')).toEqual({
      slackTeamId: 'T0ACME1234',
      fileId: 'F0ABC12345',
    });
    expect(parseSlackFileRef('https://files.slack.com/files-tmb/T0ACME1234-F0ABC12345-9f8e7d/shot_360.png')).toEqual({
      slackTeamId: 'T0ACME1234',
      fileId: 'F0ABC12345',
    });
  });

  it('parses a public slack-files.com permalink', () => {
    expect(parseSlackFileRef('https://slack-files.com/T0ACME1234-F0ABC12345-a1b2c3')).toEqual({
      slackTeamId: 'T0ACME1234',
      fileId: 'F0ABC12345',
    });
  });

  it('parses a message link (archives) with and without thread_ts', () => {
    expect(parseSlackFileRef('https://acme.slack.com/archives/C0MKTG1234/p1696771234567890')).toEqual({
      channelId: 'C0MKTG1234',
      messageTs: '1696771234.567890',
      workspaceHost: 'acme.slack.com',
    });
    expect(
      parseSlackFileRef('https://acme.slack.com/archives/C0MKTG1234/p1696771299000100?thread_ts=1696771234.567890&cid=C0MKTG1234'),
    ).toEqual({
      channelId: 'C0MKTG1234',
      messageTs: '1696771299.000100',
      threadTs: '1696771234.567890',
      workspaceHost: 'acme.slack.com',
    });
  });

  it('unwraps Slack mrkdwn links', () => {
    expect(parseSlackFileRef('<https://acme.slack.com/files/U0ELLA1234/F0ABC12345/x.md|x.md>')?.fileId).toBe('F0ABC12345');
  });

  it('rejects non-Slack, non-https and lookalike hosts', () => {
    expect(parseSlackFileRef('https://evil.example.com/files/U0ELLA1234/F0ABC12345/x')).toBeNull();
    expect(parseSlackFileRef('https://slack.com.evil.io/files/U0ELLA1234/F0ABC12345/x')).toBeNull();
    expect(parseSlackFileRef('http://acme.slack.com/files/U0ELLA1234/F0ABC12345/x')).toBeNull();
    expect(parseSlackFileRef('hello')).toBeNull();
    expect(parseSlackFileRef('')).toBeNull();
    expect(parseSlackFileRef('https://acme.slack.com/archives/C0MKTG1234')).toBeNull();
  });
});

describe('findSlackFileLinks', () => {
  it('finds file and message links in text, bare and wrapped, deduplicated', () => {
    const text = [
      'Here is the draft: https://acme.slack.com/files/U0ELLA1234/F0ABC12345/longform-en.md.',
      'Also <https://acme.slack.com/files/U0ELLA1234/F0ABC12345/longform-en.md|longform-en.md>',
      'and the post https://acme.slack.com/archives/C0MKTG1234/p1696771234567890',
      'not this https://example.com/files/x',
    ].join('\n');
    expect(findSlackFileLinks(text)).toEqual([
      'https://acme.slack.com/files/U0ELLA1234/F0ABC12345/longform-en.md',
      'https://acme.slack.com/archives/C0MKTG1234/p1696771234567890',
    ]);
  });

  it('returns nothing for plain text', () => {
    expect(findSlackFileLinks('no links here')).toEqual([]);
  });
});

describe('isTextFile / isSlackDownloadHost', () => {
  it('classifies text files by mimetype or extension', () => {
    expect(isTextFile('text/markdown', 'a.md')).toBe(true);
    expect(isTextFile('application/octet-stream', 'longform-en.md')).toBe(true);
    expect(isTextFile('application/json', 'x')).toBe(true);
    expect(isTextFile('image/png', 'a.png')).toBe(false);
    expect(isTextFile('application/pdf', 'a.pdf')).toBe(false);
  });

  it('allows Slack hosts only', () => {
    expect(isSlackDownloadHost('files.slack.com')).toBe(true);
    expect(isSlackDownloadHost('a.slack-edge.com')).toBe(true);
    expect(isSlackDownloadHost('slack.com.evil.io')).toBe(false);
  });
});

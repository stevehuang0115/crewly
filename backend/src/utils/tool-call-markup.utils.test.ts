import { hasToolCallMarkup, stripToolCallMarkup } from './tool-call-markup.utils.js';

/** Fixtures are assembled at runtime so the file itself holds no live markup. */
const OPEN = '<' + 'invoke';
const CLOSE = '</' + 'invoke>';
const POPEN = '<' + 'parameter';
const PCLOSE = '</' + 'parameter>';
const FC_OPEN = '<' + 'function_calls>';
const FC_CLOSE = '</' + 'function_calls>';

/**
 * The exact bytes deepseek-chat produced in #crewly-support (2026-09-19):
 * full-width pipes around its own separator, then a space, then `calls`.
 */
const DS_OPEN = '<' + '\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
const DS_CLOSE = '</' + '\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
const DS_INVOKE = '<' + '\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="Bash">';
const DS_INVOKE_CLOSE = '</' + '\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>';

describe('stripToolCallMarkup', () => {
  it("removes deepseek's own envelope, wrapper included (the second #crewly-support leak)", () => {
    const prose = '[Orc] I\'ll read the thread context first, then answer.';
    // The whole envelope.
    expect(stripToolCallMarkup(`${prose}\n\n${DS_OPEN}\n${DS_INVOKE}x${DS_INVOKE_CLOSE}\n${DS_CLOSE}`)).toEqual({ text: prose, stripped: true });
    // …and the empty wrapper left behind when the inner blocks are gone,
    // which is what actually reached Slack.
    expect(stripToolCallMarkup(`${prose}\n\n${DS_OPEN}\n\n${DS_CLOSE}`)).toEqual({ text: prose, stripped: true });
    expect(hasToolCallMarkup(DS_OPEN)).toBe(true);
  });

  it('matches a wrapper by shape but leaves an ordinary word ending in "calls" alone', () => {
    expect(stripToolCallMarkup('a<tool_calls>x</tool_calls>b').text).toBe('ab');
    expect(stripToolCallMarkup('he <recalls> it').text).toBe('he <recalls> it');
    expect(hasToolCallMarkup('he <recalls> it')).toBe(false);
  });

  it('keeps the prose and drops the tool-call envelope (the #crewly-support leak)', () => {
    const raw = [
      "[Orc] I'll start by reading the thread context, then survey what exists.",
      '',
      FC_OPEN,
      `${OPEN} name="Bash">`,
      `${POPEN} name="command">cat /Users/x/.crewly/slack-threads/D0A/1.md${PCLOSE}`,
      `${POPEN} name="description">Read Slack thread context file${PCLOSE}`,
      CLOSE,
      `${OPEN} name="Bash">`,
      `${POPEN} name="command">bash config/skills/orchestrator/get-team-status/execute.sh${PCLOSE}`,
      CLOSE,
      FC_CLOSE,
    ].join('\n');
    expect(stripToolCallMarkup(raw)).toEqual({
      text: "[Orc] I'll start by reading the thread context, then survey what exists.",
      stripped: true,
    });
    expect(hasToolCallMarkup(raw)).toBe(true);
  });

  it('handles a namespaced prefix and a bare invoke block with no wrapper', () => {
    const bare = `Done.\n${OPEN} name="Bash">${POPEN} name="command">ls${PCLOSE}${CLOSE}`;
    expect(stripToolCallMarkup(bare).text).toBe('Done.');
    const namespaced = `Hi\n<ns:invoke name="Bash">x</ns:invoke>`;
    expect(stripToolCallMarkup(namespaced).text).toBe('Hi');
  });

  it('cuts an envelope that was never closed (truncated output)', () => {
    const raw = `Checking the roster.\n${FC_OPEN}\n${OPEN} name="Bash">\n${POPEN} name="command">cat file`;
    expect(stripToolCallMarkup(raw)).toEqual({ text: 'Checking the roster.', stripped: true });
  });

  it('leaves ordinary text, unrelated XML and fenced examples alone', () => {
    const plain = 'Team created.\n\nNext: pick a model.';
    expect(stripToolCallMarkup(plain)).toEqual({ text: plain, stripped: false });
    expect(stripToolCallMarkup('<note>keep me</note>').text).toBe('<note>keep me</note>');
    const fenced = ['Here is the syntax:', '', '```xml', `${OPEN} name="Bash">`, CLOSE, '```'].join('\n');
    expect(stripToolCallMarkup(fenced)).toEqual({ text: fenced, stripped: false });
    expect(hasToolCallMarkup(plain)).toBe(false);
  });

  it('collapses leftover blank lines, reports an all-markup response as empty, tolerates junk input', () => {
    expect(stripToolCallMarkup(`A\n\n${OPEN} name="X">y${CLOSE}\n\n\n\nB`).text).toBe('A\n\nB');
    expect(stripToolCallMarkup(`${FC_OPEN}${OPEN} name="X">y${CLOSE}${FC_CLOSE}`)).toEqual({ text: '', stripped: true });
    expect(stripToolCallMarkup('')).toEqual({ text: '', stripped: false });
    expect(stripToolCallMarkup(undefined as unknown as string)).toEqual({ text: '', stripped: false });
  });
});

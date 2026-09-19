import { toSlackMrkdwn } from './slack-mrkdwn.js';

describe('toSlackMrkdwn', () => {
  it('unescapes literal \\n from shell quoting and converts bold/headings/bullets/links', () => {
    const input = '我查了看板。目前是 **0 条**。\\n\\n## 其他\\n- **TKT427**（P2/open）\\n- 见 [看板](https://example.com/board)';
    expect(toSlackMrkdwn(input)).toBe('我查了看板。目前是 *0 条*。\n\n*其他*\n• *TKT427*（P2/open）\n• 见 <https://example.com/board|看板>');
  });

  it('leaves code fences and inline code alone, and real newlines as they are', () => {
    const input = 'run `a **b**`\n```\n**not bold** \\n stays\n```\n**bold**';
    expect(toSlackMrkdwn(input)).toBe('run `a **b**`\n```\n**not bold** \\n stays\n```\n*bold*');
  });

  it('is a no-op on plain text and empty input', () => {
    expect(toSlackMrkdwn('hello')).toBe('hello');
    expect(toSlackMrkdwn('')).toBe('');
  });
});

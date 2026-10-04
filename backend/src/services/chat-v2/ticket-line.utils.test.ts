import { ownerVisibleContent, stripTicketDeliveryLine } from './ticket-line.utils.js';
import { appendTicketLine } from '../v3/ticket-channel-hooks.js';

describe('ticket-line.utils', () => {
  const ticket = { id: '26a0accf-c434-4113-bad2-000000000000', ticketNumber: 238 };

  it('strips exactly what appendTicketLine adds', () => {
    expect(stripTicketDeliveryLine(appendTicketLine('Rex不是用小红书的ipad app吗', ticket))).toBe('Rex不是用小红书的ipad app吗');
  });

  it('strips the legacy bridge thread hint that followed the line', () => {
    const legacy = `${appendTicketLine('hello\nsecond line', ticket)}\n\n[Thread context file: /tmp/x.md]`;
    expect(stripTicketDeliveryLine(legacy)).toBe('hello\nsecond line');
  });

  it('leaves text without an appended line alone, including an inline mention of [TICKET:', () => {
    expect(stripTicketDeliveryLine('plain')).toBe('plain');
    expect(stripTicketDeliveryLine('what does [TICKET:TKT-1 x] mean?')).toBe('what does [TICKET:TKT-1 x] mean?');
  });

  it('only rewrites user (owner) messages', () => {
    const withLine = appendTicketLine('hi', ticket);
    expect(ownerVisibleContent('user', withLine)).toBe('hi');
    expect(ownerVisibleContent('agent', withLine)).toBe(withLine);
    expect(ownerVisibleContent('system', withLine)).toBe(withLine);
  });
  it('strips a trailing thread-context hint from owner messages without a ticket line', () => {
    const hint = '启动\n\n[Thread context file: /Users/x/.crewly/slack-threads/D0AC7NF5N7L/1790966486.919839.md]';
    expect(ownerVisibleContent('user', hint)).toBe('启动');
    expect(ownerVisibleContent('agent', hint)).toBe(hint);
    expect(ownerVisibleContent('user', 'see [Thread context file: x] inline')).toBe('see [Thread context file: x] inline');
  });
});

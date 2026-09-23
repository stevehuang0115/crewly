import { afterEach, describe, expect, it } from 'vitest';
import { focusInitial } from './focus';

const isClose = (el: HTMLElement) => el.getAttribute('aria-label') === 'Close';

function panel(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

describe('focusInitial', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('skips the close button for the first real control', () => {
    const p = panel('<button aria-label="Close">x</button><input id="a" />');
    focusInitial(p, isClose);
    expect(document.activeElement?.id).toBe('a');
  });

  it('prefers data-autofocus', () => {
    const p = panel('<input id="a" /><input id="b" data-autofocus />');
    focusInitial(p, isClose);
    expect(document.activeElement?.id).toBe('b');
  });

  it('leaves focus alone when it is already inside', () => {
    const p = panel('<input id="a" /><input id="b" />');
    (p.querySelector('#b') as HTMLElement).focus();
    focusInitial(p, isClose);
    expect(document.activeElement?.id).toBe('b');
  });

  it('falls back to the close button when nothing else is focusable', () => {
    const p = panel('<button aria-label="Close">x</button>');
    focusInitial(p, isClose);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
  });
});

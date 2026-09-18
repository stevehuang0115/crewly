/**
 * ApiTokenPrompt Component Tests
 *
 * Tests cover:
 * - Hidden until the token-required event fires
 * - Saving stores the token (localStorage + cookie) and triggers the reload callback
 * - Empty input cannot be submitted
 * - Copy differs when a (rejected) token was already stored
 *
 * @module components/ApiTokenPrompt/ApiTokenPrompt.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ApiTokenPrompt } from './ApiTokenPrompt';
import { API_TOKEN_REQUIRED_EVENT } from '../../constants/api-token.constants';

function fireTokenRequired(): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(API_TOKEN_REQUIRED_EVENT));
  });
}

describe('ApiTokenPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = 'crewly_token=; Path=/; Max-Age=0';
  });

  it('renders nothing until a token challenge is raised', () => {
    render(<ApiTokenPrompt onSaved={vi.fn()} />);
    expect(screen.queryByTestId('api-token-prompt')).toBeNull();
    fireTokenRequired();
    expect(screen.getByTestId('api-token-prompt')).toBeInTheDocument();
    expect(screen.getAllByText(/crewly token/).length).toBeGreaterThan(0);
  });

  it('stores the trimmed token, sets the cookie and calls onSaved', () => {
    const onSaved = vi.fn();
    render(<ApiTokenPrompt onSaved={onSaved} />);
    fireTokenRequired();

    fireEvent.change(screen.getByTestId('api-token-input'), { target: { value: '  my-token  ' } });
    fireEvent.click(screen.getByTestId('api-token-submit'));

    expect(localStorage.getItem('crewly_api_token')).toBe('my-token');
    expect(document.cookie).toContain('crewly_token=my-token');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('api-token-prompt')).toBeNull();
  });

  it('disables submit while the input is empty', () => {
    render(<ApiTokenPrompt onSaved={vi.fn()} />);
    fireTokenRequired();
    expect(screen.getByTestId('api-token-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('api-token-input'), { target: { value: '   ' } });
    expect(screen.getByTestId('api-token-submit')).toBeDisabled();
  });

  it('explains that the stored token was rejected when one already exists', () => {
    localStorage.setItem('crewly_api_token', 'stale');
    render(<ApiTokenPrompt onSaved={vi.fn()} />);
    fireTokenRequired();
    expect(screen.getByText(/was rejected/)).toBeInTheDocument();
  });
});

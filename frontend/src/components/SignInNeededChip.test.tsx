/**
 * SignInNeededChip Tests
 *
 * @module components/SignInNeededChip.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SignInNeededChip } from './SignInNeededChip';

const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
Object.assign(navigator, { clipboard: mockClipboard });

const loginRequired = {
  url: 'https://auth.openai.com/device',
  code: 'FBVZ-MJHKK',
  detectedAt: '2026-09-18T10:00:00.000Z',
};

describe('SignInNeededChip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the chip label and keeps the panel closed by default', () => {
    render(<SignInNeededChip loginRequired={loginRequired} />);
    expect(screen.getByRole('button', { name: /sign-in needed/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a panel with the URL as a link and the device code', () => {
    render(<SignInNeededChip loginRequired={loginRequired} agentLabel="Orchestrator" />);
    fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Orchestrator needs you to sign in');
    const link = screen.getByTestId('sign-in-url');
    expect(link).toHaveAttribute('href', loginRequired.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('sign-in-code')).toHaveTextContent('FBVZ-MJHKK');
  });

  it('copies the device code to the clipboard and shows feedback', async () => {
    render(<SignInNeededChip loginRequired={loginRequired} />);
    fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
    fireEvent.click(screen.getByRole('button', { name: /copy code to clipboard/i }));

    await waitFor(() => expect(mockClipboard.writeText).toHaveBeenCalledWith('FBVZ-MJHKK'));
    await waitFor(() => expect(screen.getByRole('button', { name: /code copied/i })).toBeInTheDocument());
  });

  it('explains when no URL or code was captured', () => {
    render(<SignInNeededChip loginRequired={{ url: null, code: null, detectedAt: 'not-a-date' }} />);
    fireEvent.click(screen.getByRole('button', { name: /sign-in needed/i }));
    expect(screen.getByText(/No login URL was captured/)).toBeInTheDocument();
    expect(screen.getByText(/No device code/)).toBeInTheDocument();
    expect(screen.queryByText(/Detected/)).not.toBeInTheDocument();
  });

  it('closes on Escape and on outside click, and does not bubble clicks to the parent', () => {
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <SignInNeededChip loginRequired={loginRequired} />
        <span>outside</span>
      </div>,
    );
    const chip = screen.getByRole('button', { name: /sign-in needed/i });

    fireEvent.click(chip);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onParentClick).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(chip);
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

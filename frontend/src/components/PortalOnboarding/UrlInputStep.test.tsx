/**
 * Tests for UrlInputStep component.
 *
 * @module components/PortalOnboarding/UrlInputStep.test
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UrlInputStep } from './UrlInputStep';

describe('UrlInputStep', () => {
  it('renders headline', () => {
    render(<UrlInputStep onSubmit={vi.fn()} />);
    expect(
      screen.getByText(/build your first crewly workspace/i)
    ).toBeInTheDocument();
  });

  it('renders URL input', () => {
    render(<UrlInputStep onSubmit={vi.fn()} />);
    expect(screen.getByTestId('url-input')).toBeInTheDocument();
  });

  it('renders generate button', () => {
    render(<UrlInputStep onSubmit={vi.fn()} />);
    expect(screen.getByTestId('generate-preview-btn')).toBeInTheDocument();
  });

  it('disables button when URL is empty', () => {
    render(<UrlInputStep onSubmit={vi.fn()} />);
    const btn = screen.getByTestId('generate-preview-btn');
    expect(btn).toBeDisabled();
  });

  it('enables button when URL is valid', () => {
    render(<UrlInputStep onSubmit={vi.fn()} />);
    const input = screen.getByTestId('url-input');
    fireEvent.change(input, { target: { value: 'acme.com' } });
    const btn = screen.getByTestId('generate-preview-btn');
    expect(btn).not.toBeDisabled();
  });

  it('shows error for invalid URL after blur', () => {
    render(<UrlInputStep onSubmit={vi.fn()} />);
    const input = screen.getByTestId('url-input');
    fireEvent.change(input, { target: { value: 'not-a-url' } });
    fireEvent.blur(input);
    expect(screen.getByText('Enter a valid website URL')).toBeInTheDocument();
  });

  it('calls onSubmit with normalized URL on form submit', () => {
    const onSubmit = vi.fn();
    render(<UrlInputStep onSubmit={onSubmit} />);
    const input = screen.getByTestId('url-input');
    fireEvent.change(input, { target: { value: 'acme.com' } });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith('https://acme.com');
  });

  it('preserves https:// if already present', () => {
    const onSubmit = vi.fn();
    render(<UrlInputStep onSubmit={onSubmit} />);
    const input = screen.getByTestId('url-input');
    fireEvent.change(input, { target: { value: 'https://acme.com' } });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith('https://acme.com');
  });

  it('shows trust signals', () => {
    render(<UrlInputStep onSubmit={vi.fn()} />);
    expect(screen.getByText('Same-domain crawl only')).toBeInTheDocument();
    expect(screen.getByText('Editable before save')).toBeInTheDocument();
    expect(screen.getByText(/usually done/i)).toBeInTheDocument();
  });

  it('shows manual setup link when handler provided', () => {
    render(<UrlInputStep onSubmit={vi.fn()} onManualSetup={vi.fn()} />);
    expect(screen.getByTestId('manual-setup-link')).toBeInTheDocument();
  });

  it('calls onManualSetup when link clicked', () => {
    const onManual = vi.fn();
    render(<UrlInputStep onSubmit={vi.fn()} onManualSetup={onManual} />);
    fireEvent.click(screen.getByTestId('manual-setup-link'));
    expect(onManual).toHaveBeenCalledOnce();
  });

  it('shows loading state when submitting', () => {
    render(<UrlInputStep onSubmit={vi.fn()} isSubmitting={true} />);
    const btn = screen.getByTestId('generate-preview-btn');
    expect(btn).toBeDisabled();
  });
});

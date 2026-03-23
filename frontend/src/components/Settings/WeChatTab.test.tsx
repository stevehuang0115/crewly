/**
 * Tests for WeChat Integration Tab.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WeChatTab } from './WeChatTab';

describe('WeChatTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('renders the tab with title', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { state: 'disconnected', botName: null } }),
    });

    render(<WeChatTab />);
    expect(screen.getByText('WeChat Integration')).toBeDefined();
    expect(screen.getByText('Not connected')).toBeDefined();
  });

  it('shows connect button when disconnected', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { state: 'disconnected', botName: null } }),
    });

    render(<WeChatTab />);
    expect(screen.getByTestId('wechat-connect')).toBeDefined();
  });

  it('shows QR code after connect click', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    // First call: status (disconnected)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { state: 'disconnected', botName: null } }),
    });
    // Second call: qrcode
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { qrcodeUrl: 'https://qr.test/code.png', ticket: 'tk' } }),
    });

    render(<WeChatTab />);

    const connectBtn = screen.getByTestId('wechat-connect');
    fireEvent.click(connectBtn);

    await waitFor(() => {
      expect(screen.getByTestId('wechat-qr')).toBeDefined();
    });
  });

  it('shows connected state with bot name', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { state: 'connected', botName: 'MyBot' } }),
    });

    render(<WeChatTab />);

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeDefined();
      expect(screen.getByText('MyBot')).toBeDefined();
      expect(screen.getByTestId('wechat-disconnect')).toBeDefined();
    });
  });

  it('shows error on connect failure', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { state: 'disconnected', botName: null } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    render(<WeChatTab />);

    fireEvent.click(screen.getByTestId('wechat-connect'));

    await waitFor(() => {
      expect(screen.getByTestId('wechat-error')).toBeDefined();
    });
  });
});

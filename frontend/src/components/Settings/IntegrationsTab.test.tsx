/**
 * Tests for IntegrationsTab Component
 *
 * @module components/Settings/IntegrationsTab.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { IntegrationsTab } from './IntegrationsTab';

// Mock child platform tab components
vi.mock('./SlackTab', () => ({
  SlackTab: () => <div data-testid="slack-tab-content">Slack Config</div>,
}));

vi.mock('./WhatsAppTab', () => ({
  WhatsAppTab: () => <div data-testid="whatsapp-tab-content">WhatsApp Config</div>,
}));

vi.mock('./GoogleChatTab', () => ({
  GoogleChatTab: () => <div data-testid="google-chat-tab-content">Google Chat Config</div>,
}));

vi.mock('./TelegramTab', () => ({
  TelegramTab: () => <div data-testid="telegram-tab-content">Telegram Config</div>,
}));

vi.mock('./DiscordTab', () => ({
  DiscordTab: () => <div data-testid="discord-tab-content">Discord Config</div>,
}));

describe('IntegrationsTab', () => {
  describe('Rendering', () => {
    it('should render header', () => {
      render(<IntegrationsTab />);

      expect(screen.getByText('Messaging Integrations')).toBeInTheDocument();
      expect(screen.getByText(/Connect messaging platforms/)).toBeInTheDocument();
    });

    it('should render all platform cards', () => {
      render(<IntegrationsTab />);

      expect(screen.getByText('Slack')).toBeInTheDocument();
      expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      expect(screen.getByText('Discord')).toBeInTheDocument();
      expect(screen.getByText('Telegram')).toBeInTheDocument();
      expect(screen.getByText('Google Chat')).toBeInTheDocument();
    });

    it('should not show Coming Soon badges when all platforms are available', () => {
      render(<IntegrationsTab />);

      expect(screen.queryByText('Coming Soon')).not.toBeInTheDocument();
    });

    it('should have data-testid on platform cards', () => {
      render(<IntegrationsTab />);

      expect(screen.getByTestId('platform-card-slack')).toBeInTheDocument();
      expect(screen.getByTestId('platform-card-whatsapp')).toBeInTheDocument();
      expect(screen.getByTestId('platform-card-discord')).toBeInTheDocument();
    });
  });

  describe('Platform Expansion', () => {
    it('should not show any platform content by default', () => {
      render(<IntegrationsTab />);

      expect(screen.queryByTestId('platform-content-slack')).not.toBeInTheDocument();
      expect(screen.queryByTestId('platform-content-whatsapp')).not.toBeInTheDocument();
    });

    it('should expand Slack card when clicked', () => {
      render(<IntegrationsTab />);

      fireEvent.click(screen.getByTestId('platform-toggle-slack'));

      expect(screen.getByTestId('platform-content-slack')).toBeInTheDocument();
      expect(screen.getByTestId('slack-tab-content')).toBeInTheDocument();
    });

    it('should expand WhatsApp card when clicked', () => {
      render(<IntegrationsTab />);

      fireEvent.click(screen.getByTestId('platform-toggle-whatsapp'));

      expect(screen.getByTestId('platform-content-whatsapp')).toBeInTheDocument();
      expect(screen.getByTestId('whatsapp-tab-content')).toBeInTheDocument();
    });

    it('should collapse platform when clicking again', () => {
      render(<IntegrationsTab />);

      // Expand
      fireEvent.click(screen.getByTestId('platform-toggle-slack'));
      expect(screen.getByTestId('platform-content-slack')).toBeInTheDocument();

      // Collapse
      fireEvent.click(screen.getByTestId('platform-toggle-slack'));
      expect(screen.queryByTestId('platform-content-slack')).not.toBeInTheDocument();
    });

    it('should collapse previous platform when expanding another', () => {
      render(<IntegrationsTab />);

      // Expand Slack
      fireEvent.click(screen.getByTestId('platform-toggle-slack'));
      expect(screen.getByTestId('platform-content-slack')).toBeInTheDocument();

      // Expand WhatsApp (should collapse Slack)
      fireEvent.click(screen.getByTestId('platform-toggle-whatsapp'));
      expect(screen.queryByTestId('platform-content-slack')).not.toBeInTheDocument();
      expect(screen.getByTestId('platform-content-whatsapp')).toBeInTheDocument();
    });

    it('should expand Google Chat card when clicked', () => {
      render(<IntegrationsTab />);

      fireEvent.click(screen.getByTestId('platform-toggle-google-chat'));

      expect(screen.getByTestId('platform-content-google-chat')).toBeInTheDocument();
      expect(screen.getByTestId('google-chat-tab-content')).toBeInTheDocument();
    });

    it('should expand Discord card when clicked', () => {
      render(<IntegrationsTab />);

      fireEvent.click(screen.getByTestId('platform-toggle-discord'));

      expect(screen.getByTestId('platform-content-discord')).toBeInTheDocument();
      expect(screen.getByTestId('discord-tab-content')).toBeInTheDocument();
    });

    it('should expand Telegram card when clicked', () => {
      render(<IntegrationsTab />);

      fireEvent.click(screen.getByTestId('platform-toggle-telegram'));

      expect(screen.getByTestId('platform-content-telegram')).toBeInTheDocument();
      expect(screen.getByTestId('telegram-tab-content')).toBeInTheDocument();
    });
  });
});

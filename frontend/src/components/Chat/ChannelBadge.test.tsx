/**
 * Channel Badge Tests
 *
 * Tests for the ChannelBadge component that displays channel type
 * icons and labels for conversations.
 *
 * @module components/Chat/ChannelBadge.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { ChannelBadge } from './ChannelBadge';
import type { ChatChannelType } from '../../types/chat.types';

describe('ChannelBadge', () => {
  describe('channel type rendering', () => {
    it('renders correct icon and label for slack channel', () => {
      render(<ChannelBadge channelType="slack" />);

      const badge = screen.getByTestId('channel-badge');
      expect(badge).toBeInTheDocument();
      expect(screen.getByText('Slack')).toBeInTheDocument();
    });

    it('renders correct icon and label for crewly_chat channel', () => {
      render(<ChannelBadge channelType="crewly_chat" />);

      const badge = screen.getByTestId('channel-badge');
      expect(badge).toBeInTheDocument();
      expect(screen.getByText('Crewly')).toBeInTheDocument();
    });

    it('renders correct icon and label for telegram channel', () => {
      render(<ChannelBadge channelType="telegram" />);

      const badge = screen.getByTestId('channel-badge');
      expect(badge).toBeInTheDocument();
      expect(screen.getByText('Telegram')).toBeInTheDocument();
    });

    it('renders correct icon and label for api channel', () => {
      render(<ChannelBadge channelType="api" />);

      const badge = screen.getByTestId('channel-badge');
      expect(badge).toBeInTheDocument();
      expect(screen.getByText('API')).toBeInTheDocument();
    });
  });

  describe('showLabel prop', () => {
    it('shows label by default (showLabel defaults to true)', () => {
      render(<ChannelBadge channelType="slack" />);

      expect(screen.getByText('Slack')).toBeInTheDocument();
    });

    it('shows label when showLabel is explicitly true', () => {
      render(<ChannelBadge channelType="slack" showLabel={true} />);

      expect(screen.getByText('Slack')).toBeInTheDocument();
    });

    it('hides label when showLabel is false', () => {
      render(<ChannelBadge channelType="slack" showLabel={false} />);

      expect(screen.queryByText('Slack')).not.toBeInTheDocument();
    });
  });

  describe('data-testid', () => {
    it('has data-testid="channel-badge"', () => {
      render(<ChannelBadge channelType="crewly_chat" />);

      expect(screen.getByTestId('channel-badge')).toBeInTheDocument();
    });
  });

  describe('title attribute', () => {
    it('shows correct title for slack', () => {
      render(<ChannelBadge channelType="slack" />);

      expect(screen.getByTestId('channel-badge')).toHaveAttribute('title', 'Slack');
    });

    it('shows correct title for crewly_chat', () => {
      render(<ChannelBadge channelType="crewly_chat" />);

      expect(screen.getByTestId('channel-badge')).toHaveAttribute('title', 'Crewly');
    });

    it('shows correct title for telegram', () => {
      render(<ChannelBadge channelType="telegram" />);

      expect(screen.getByTestId('channel-badge')).toHaveAttribute('title', 'Telegram');
    });

    it('shows correct title for api', () => {
      render(<ChannelBadge channelType="api" />);

      expect(screen.getByTestId('channel-badge')).toHaveAttribute('title', 'API');
    });
  });

  describe('CSS classes', () => {
    it('applies channel-specific CSS class for slack', () => {
      render(<ChannelBadge channelType="slack" />);

      const badge = screen.getByTestId('channel-badge');
      expect(badge).toHaveClass('channel-badge');
      expect(badge).toHaveClass('channel-slack');
    });

    it('applies channel-specific CSS class for crewly_chat', () => {
      render(<ChannelBadge channelType="crewly_chat" />);

      const badge = screen.getByTestId('channel-badge');
      expect(badge).toHaveClass('channel-badge');
      expect(badge).toHaveClass('channel-crewly');
    });

    it('applies channel-specific CSS class for telegram', () => {
      render(<ChannelBadge channelType="telegram" />);

      const badge = screen.getByTestId('channel-badge');
      expect(badge).toHaveClass('channel-badge');
      expect(badge).toHaveClass('channel-telegram');
    });

    it('applies channel-specific CSS class for api', () => {
      render(<ChannelBadge channelType="api" />);

      const badge = screen.getByTestId('channel-badge');
      expect(badge).toHaveClass('channel-badge');
      expect(badge).toHaveClass('channel-api');
    });

    it('uses shared Badge component (has rounded-full class)', () => {
      render(<ChannelBadge channelType="slack" />);

      const badge = screen.getByTestId('channel-badge');
      expect(badge).toHaveClass('rounded-full');
    });
  });

  describe('icon accessibility', () => {
    it('marks icon as aria-hidden', () => {
      render(<ChannelBadge channelType="slack" />);

      const badge = screen.getByTestId('channel-badge');
      const icon = badge.querySelector('[aria-hidden="true"]');
      expect(icon).toBeInTheDocument();
    });
  });
});

/**
 * Tests for GeneralTab Component
 *
 * @module components/Settings/GeneralTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { GeneralTab } from './GeneralTab';
import * as useSettingsHook from '../../hooks/useSettings';

describe('GeneralTab', () => {
  const mockSettings = {
    general: {
      defaultRuntime: 'claude-code' as const,
      autoStartOrchestrator: false,
      checkInIntervalMinutes: 5,
      maxConcurrentAgents: 10,
      verboseLogging: false,
      autoResumeOnRestart: true,
      runtimeCommands: {
        'claude-code': 'claude --dangerously-skip-permissions',
        'gemini-cli': 'gemini --yolo',
        'codex-cli': 'codex -a never -s danger-full-access',
        'crewly-agent': 'crewly-agent-in-process',
      },
      agentIdleTimeoutMinutes: 30,
      enableProactiveCompact: true,
      enableSelfEvolution: false,
      enableAuditor: false,
    },
    chat: {
      showRawTerminalOutput: false,
      enableTypingIndicator: true,
      maxMessageHistory: 1000,
      autoScrollToBottom: true,
      showTimestamps: true,
    },
    skills: {
      skillsDirectory: '',
      enableBrowserAutomation: true,
      enableScriptExecution: true,
      skillExecutionTimeoutMs: 60000,
    },
  };

  const mockUpdateSettings = vi.fn().mockResolvedValue(mockSettings);
  const mockResetSection = vi.fn().mockResolvedValue(mockSettings);
  const mockRefreshSettings = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(useSettingsHook, 'useSettings').mockReturnValue({
      settings: mockSettings,
      updateSettings: mockUpdateSettings,
      resetSettings: vi.fn().mockResolvedValue(mockSettings),
      resetSection: mockResetSection,
      refreshSettings: mockRefreshSettings,
      isLoading: false,
      error: null,
    });
  });

  describe('Rendering', () => {
    it('should render runtime settings section', () => {
      render(<GeneralTab />);

      expect(screen.getByText('Runtime Settings')).toBeInTheDocument();
      expect(screen.getByLabelText('Default AI Runtime')).toBeInTheDocument();
    });

    it('should render chat settings section', () => {
      render(<GeneralTab />);

      expect(screen.getByText('Chat Settings')).toBeInTheDocument();
      expect(screen.getByLabelText('Show Raw Terminal Output')).toBeInTheDocument();
    });

    it('should render all general settings fields', () => {
      render(<GeneralTab />);

      expect(screen.getByLabelText('Default AI Runtime')).toBeInTheDocument();
      expect(screen.getByLabelText('Auto-Start Orchestrator')).toBeInTheDocument();
      expect(screen.getByLabelText('Auto-Resume Sessions on Restart')).toBeInTheDocument();
      expect(screen.getByLabelText('Check-in Interval (minutes)')).toBeInTheDocument();
      expect(screen.getByLabelText('Max Concurrent Agents')).toBeInTheDocument();
      expect(screen.getByLabelText('Verbose Logging')).toBeInTheDocument();
      expect(screen.getByLabelText('Enable Auditor')).toBeInTheDocument();
      expect(screen.getByLabelText('Agent Idle Timeout (minutes)')).toBeInTheDocument();
    });

    it('should render Enable Auditor toggle as unchecked by default', () => {
      render(<GeneralTab />);

      const toggle = screen.getByLabelText('Enable Auditor') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
    });

    it('should toggle Enable Auditor and mark changes dirty', () => {
      render(<GeneralTab />);

      const toggle = screen.getByLabelText('Enable Auditor');
      fireEvent.click(toggle);

      const saveButton = screen.getByText('Save Changes').closest('button');
      expect(saveButton).not.toBeDisabled();
    });

    it('should render all chat settings fields', () => {
      render(<GeneralTab />);

      expect(screen.getByLabelText('Show Raw Terminal Output')).toBeInTheDocument();
      expect(screen.getByLabelText('Enable Typing Indicator')).toBeInTheDocument();
      expect(screen.getByLabelText('Message History Limit')).toBeInTheDocument();
      expect(screen.getByLabelText('Auto-Scroll to Bottom')).toBeInTheDocument();
      expect(screen.getByLabelText('Show Timestamps')).toBeInTheDocument();
    });

    it('should render runtime commands section', () => {
      render(<GeneralTab />);

      expect(screen.getByText('Runtime Commands')).toBeInTheDocument();
      expect(screen.getByLabelText('Claude Code')).toBeInTheDocument();
      expect(screen.getByLabelText('Gemini CLI')).toBeInTheDocument();
      expect(screen.getByLabelText('Codex CLI')).toBeInTheDocument();
    });

    it('should render runtime command values', () => {
      render(<GeneralTab />);

      const claudeInput = screen.getByLabelText('Claude Code') as HTMLInputElement;
      expect(claudeInput.value).toBe('claude --dangerously-skip-permissions');

      const geminiInput = screen.getByLabelText('Gemini CLI') as HTMLInputElement;
      expect(geminiInput.value).toBe('gemini --yolo');

      const codexInput = screen.getByLabelText('Codex CLI') as HTMLInputElement;
      expect(codexInput.value).toBe('codex -a never -s danger-full-access');
    });

    it('should render action buttons', () => {
      render(<GeneralTab />);

      expect(screen.getByText('Reset to Defaults')).toBeInTheDocument();
      expect(screen.getByText('Save Changes')).toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('should show loading state when loading', () => {
      vi.spyOn(useSettingsHook, 'useSettings').mockReturnValue({
        settings: null,
        updateSettings: mockUpdateSettings,
        resetSettings: vi.fn(),
        resetSection: mockResetSection,
        refreshSettings: mockRefreshSettings,
        isLoading: true,
        error: null,
      });

      render(<GeneralTab />);

      expect(screen.getByText('Loading settings...')).toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('should show error state when error occurs', () => {
      vi.spyOn(useSettingsHook, 'useSettings').mockReturnValue({
        settings: null,
        updateSettings: mockUpdateSettings,
        resetSettings: vi.fn(),
        resetSection: mockResetSection,
        refreshSettings: mockRefreshSettings,
        isLoading: false,
        error: 'Failed to load settings',
      });

      render(<GeneralTab />);

      expect(screen.getByText(/Error loading settings/)).toBeInTheDocument();
      expect(screen.getByText(/Failed to load settings/)).toBeInTheDocument();
    });
  });

  describe('User Interactions', () => {
    it('should update local state on checkbox change', () => {
      render(<GeneralTab />);

      const checkbox = screen.getByLabelText('Auto-Start Orchestrator');
      expect(checkbox).not.toBeChecked();

      fireEvent.click(checkbox);

      expect(checkbox).toBeChecked();
    });

    it('should update auto-resume checkbox', () => {
      render(<GeneralTab />);

      const checkbox = screen.getByLabelText('Auto-Resume Sessions on Restart');
      expect(checkbox).toBeChecked();

      fireEvent.click(checkbox);

      expect(checkbox).not.toBeChecked();
    });

    it('should update local state on select change', () => {
      render(<GeneralTab />);

      const select = screen.getByLabelText('Default AI Runtime') as HTMLSelectElement;
      expect(select.value).toBe('claude-code');

      fireEvent.change(select, { target: { value: 'gemini-cli' } });

      expect(select.value).toBe('gemini-cli');
    });

    it('should update local state on runtime command change', () => {
      render(<GeneralTab />);

      const geminiInput = screen.getByLabelText('Gemini CLI') as HTMLInputElement;
      fireEvent.change(geminiInput, { target: { value: 'gemini --custom-flag' } });

      expect(geminiInput.value).toBe('gemini --custom-flag');
    });

    it('should update local state on number input change', () => {
      render(<GeneralTab />);

      const input = screen.getByLabelText('Check-in Interval (minutes)') as HTMLInputElement;
      expect(input.value).toBe('5');

      fireEvent.change(input, { target: { value: '10' } });

      expect(input.value).toBe('10');
    });

    it('should render idle timeout with current value and allow changes', () => {
      render(<GeneralTab />);

      const input = screen.getByLabelText('Agent Idle Timeout (minutes)') as HTMLInputElement;
      expect(input.value).toBe('30');

      fireEvent.change(input, { target: { value: '60' } });

      expect(input.value).toBe('60');

      // Should enable save button
      const saveButton = screen.getByText('Save Changes').closest('button');
      expect(saveButton).not.toBeDisabled();
    });

    it('should allow setting idle timeout to 0 to disable suspension', () => {
      render(<GeneralTab />);

      const input = screen.getByLabelText('Agent Idle Timeout (minutes)') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '0' } });

      expect(input.value).toBe('0');
    });
  });

  describe('Save Functionality', () => {
    it('should call updateSettings on save', async () => {
      render(<GeneralTab />);

      // Make a change
      const checkbox = screen.getByLabelText('Auto-Start Orchestrator');
      fireEvent.click(checkbox);

      // Click save
      const saveButton = screen.getByText('Save Changes');
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });
    });

    it('should disable save button when no changes made', () => {
      render(<GeneralTab />);

      const saveButton = screen.getByText('Save Changes').closest('button');
      expect(saveButton).toBeDisabled();
    });

    it('should enable save button after making changes', () => {
      render(<GeneralTab />);

      const checkbox = screen.getByLabelText('Auto-Start Orchestrator');
      fireEvent.click(checkbox);

      const saveButton = screen.getByText('Save Changes');
      expect(saveButton).not.toBeDisabled();
    });

    it('should show saving state while saving', async () => {
      mockUpdateSettings.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(mockSettings), 100)));

      render(<GeneralTab />);

      // Make a change
      const checkbox = screen.getByLabelText('Auto-Start Orchestrator');
      fireEvent.click(checkbox);

      // Click save
      const saveButton = screen.getByText('Save Changes');
      fireEvent.click(saveButton);

      expect(screen.getByText('Saving...')).toBeInTheDocument();
    });
  });

  describe('Reset Functionality', () => {
    it('should call resetSection on reset confirmation', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      render(<GeneralTab />);

      const resetButton = screen.getByText('Reset to Defaults');
      fireEvent.click(resetButton);

      await waitFor(() => {
        expect(mockResetSection).toHaveBeenCalledWith('general');
        expect(mockResetSection).toHaveBeenCalledWith('chat');
      });
    });

    it('should not call resetSection when reset is cancelled', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      render(<GeneralTab />);

      const resetButton = screen.getByText('Reset to Defaults');
      fireEvent.click(resetButton);

      expect(mockResetSection).not.toHaveBeenCalled();
    });
  });
});

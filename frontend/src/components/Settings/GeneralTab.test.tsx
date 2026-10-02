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
        'opencode-cli': 'opencode --auto',
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

      expect(screen.getByText('Agents')).toBeInTheDocument();
      expect(screen.getByLabelText('Default AI runtime')).toBeInTheDocument();
    });

    it('should render chat settings section', () => {
      render(<GeneralTab />);

      expect(screen.getByText('Chat')).toBeInTheDocument();
      expect(screen.getByLabelText('Show raw terminal output')).toBeInTheDocument();
    });

    it('should render all general settings fields', () => {
      render(<GeneralTab />);

      expect(screen.getByLabelText('Default AI runtime')).toBeInTheDocument();
      expect(screen.getByLabelText('Auto-start orchestrator')).toBeInTheDocument();
      expect(screen.getByLabelText('Auto-resume sessions on restart')).toBeInTheDocument();
      expect(screen.getByLabelText('Check-in interval (minutes)')).toBeInTheDocument();
      expect(screen.getByLabelText('Max concurrent agents')).toBeInTheDocument();
      expect(screen.getByLabelText('Verbose logging')).toBeInTheDocument();
      expect(screen.getByLabelText('Enable auditor')).toBeInTheDocument();
      expect(screen.getByLabelText('Agent idle timeout (minutes)')).toBeInTheDocument();
    });

    it('should render Enable Auditor toggle as unchecked by default', () => {
      render(<GeneralTab />);

      const toggle = screen.getByLabelText('Enable auditor') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
    });

    it('should toggle Enable Auditor and mark changes dirty', () => {
      render(<GeneralTab />);

      const toggle = screen.getByLabelText('Enable auditor');
      fireEvent.click(toggle);

      const saveButton = screen.getByText('Save changes').closest('button');
      expect(saveButton).not.toBeDisabled();
    });

    it('should render all chat settings fields', () => {
      render(<GeneralTab />);

      expect(screen.getByLabelText('Show raw terminal output')).toBeInTheDocument();
      expect(screen.getByLabelText('Typing indicator')).toBeInTheDocument();
      expect(screen.getByLabelText('Message history limit')).toBeInTheDocument();
      expect(screen.getByLabelText('Auto-scroll to bottom')).toBeInTheDocument();
      expect(screen.getByLabelText('Show timestamps')).toBeInTheDocument();
    });

    it('should render runtime commands section', () => {
      render(<GeneralTab />);

      expect(screen.getByText('Runtime commands')).toBeInTheDocument();
      expect(screen.getByLabelText('Claude Code')).toBeInTheDocument();
      expect(screen.getByLabelText('Gemini CLI')).toBeInTheDocument();
      expect(screen.getByLabelText('Codex CLI')).toBeInTheDocument();
      expect(screen.getByLabelText('OpenCode CLI')).toBeInTheDocument();
    });

    it('should render runtime command values', () => {
      render(<GeneralTab />);

      const claudeInput = screen.getByLabelText('Claude Code') as HTMLInputElement;
      expect(claudeInput.value).toBe('claude --dangerously-skip-permissions');

      const geminiInput = screen.getByLabelText('Gemini CLI') as HTMLInputElement;
      expect(geminiInput.value).toBe('gemini --yolo');

      const codexInput = screen.getByLabelText('Codex CLI') as HTMLInputElement;
      expect(codexInput.value).toBe('codex -a never -s danger-full-access');

      const opencodeInput = screen.getByLabelText('OpenCode CLI') as HTMLInputElement;
      expect(opencodeInput.value).toBe('opencode --auto');
    });

    it('should render action buttons', () => {
      render(<GeneralTab />);

      expect(screen.getByText('Reset to defaults')).toBeInTheDocument();
      expect(screen.getByText('Save changes')).toBeInTheDocument();
    });
  });

  describe('Advanced section', () => {
    it('keeps the less-changed settings in a collapsed Advanced section', () => {
      render(<GeneralTab />);

      const advanced = screen.getByTestId('general-advanced');
      const toggle = advanced.querySelector('button[aria-expanded]') as HTMLButtonElement;
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByLabelText('Check-in interval (minutes)')).not.toBeVisible();
      expect(screen.getByLabelText('Default AI runtime')).toBeVisible();

      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByLabelText('Check-in interval (minutes)')).toBeVisible();
      expect(screen.getByLabelText('Claude Code')).toBeVisible();
      expect(screen.getByLabelText('Message history limit')).toBeVisible();
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

      const checkbox = screen.getByLabelText('Auto-start orchestrator');
      expect(checkbox).not.toBeChecked();

      fireEvent.click(checkbox);

      expect(checkbox).toBeChecked();
    });

    it('should update auto-resume checkbox', () => {
      render(<GeneralTab />);

      const checkbox = screen.getByLabelText('Auto-resume sessions on restart');
      expect(checkbox).toBeChecked();

      fireEvent.click(checkbox);

      expect(checkbox).not.toBeChecked();
    });

    it('shows automatic updates on by default and toggles it off', () => {
      render(<GeneralTab />);

      const checkbox = screen.getByLabelText('Automatic updates');
      expect(checkbox).toBeChecked();

      fireEvent.click(checkbox);

      expect(checkbox).not.toBeChecked();
    });

    it('should update local state on select change', () => {
      render(<GeneralTab />);

      const select = screen.getByLabelText('Default AI runtime') as HTMLSelectElement;
      expect(select.value).toBe('claude-code');

      fireEvent.change(select, { target: { value: 'antigravity-cli' } });

      expect(select.value).toBe('antigravity-cli');
    });

    it('offers Antigravity CLI but not the retired Gemini CLI as the default runtime', () => {
      render(<GeneralTab />);

      const select = screen.getByLabelText('Default AI runtime') as HTMLSelectElement;
      const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
      expect(values).toContain('antigravity-cli');
      expect(values).not.toContain('gemini-cli');
    });

    it('keeps an existing Gemini CLI default, labelled "(enterprise only)"', () => {
      vi.spyOn(useSettingsHook, 'useSettings').mockReturnValue({
        settings: { ...mockSettings, general: { ...mockSettings.general, defaultRuntime: 'gemini-cli' as const } },
        updateSettings: mockUpdateSettings,
        resetSettings: vi.fn().mockResolvedValue(mockSettings),
        resetSection: mockResetSection,
        refreshSettings: mockRefreshSettings,
        isLoading: false,
        error: null,
      } as never);
      render(<GeneralTab />);

      const select = screen.getByLabelText('Default AI runtime') as HTMLSelectElement;
      expect(select.value).toBe('gemini-cli');
      expect(select.querySelector('option[value="gemini-cli"]')?.textContent).toBe('Gemini CLI (enterprise only)');
    });

    it('should update local state on runtime command change', () => {
      render(<GeneralTab />);

      const geminiInput = screen.getByLabelText('Gemini CLI') as HTMLInputElement;
      fireEvent.change(geminiInput, { target: { value: 'gemini --custom-flag' } });

      expect(geminiInput.value).toBe('gemini --custom-flag');
    });

    it('should update local state on number input change', () => {
      render(<GeneralTab />);

      const input = screen.getByLabelText('Check-in interval (minutes)') as HTMLInputElement;
      expect(input.value).toBe('5');

      fireEvent.change(input, { target: { value: '10' } });

      expect(input.value).toBe('10');
    });

    it('should render idle timeout with current value and allow changes', () => {
      render(<GeneralTab />);

      const input = screen.getByLabelText('Agent idle timeout (minutes)') as HTMLInputElement;
      expect(input.value).toBe('30');

      fireEvent.change(input, { target: { value: '60' } });

      expect(input.value).toBe('60');

      // Should enable save button
      const saveButton = screen.getByText('Save changes').closest('button');
      expect(saveButton).not.toBeDisabled();
    });

    it('should allow setting idle timeout to 0 to disable suspension', () => {
      render(<GeneralTab />);

      const input = screen.getByLabelText('Agent idle timeout (minutes)') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '0' } });

      expect(input.value).toBe('0');
    });
  });

  describe('Save Functionality', () => {
    it('should call updateSettings on save', async () => {
      render(<GeneralTab />);

      // Make a change
      const checkbox = screen.getByLabelText('Auto-start orchestrator');
      fireEvent.click(checkbox);

      // Click save
      const saveButton = screen.getByText('Save changes');
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalled();
      });
    });

    it('saves autoUpdate: false when automatic updates are switched off', async () => {
      render(<GeneralTab />);

      fireEvent.click(screen.getByLabelText('Automatic updates'));
      fireEvent.click(screen.getByText('Save changes'));

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith(
          expect.objectContaining({ general: expect.objectContaining({ autoUpdate: false }) }),
        );
      });
    });

    it('should disable save button when no changes made', () => {
      render(<GeneralTab />);

      const saveButton = screen.getByText('Save changes').closest('button');
      expect(saveButton).toBeDisabled();
    });

    it('should enable save button after making changes', () => {
      render(<GeneralTab />);

      const checkbox = screen.getByLabelText('Auto-start orchestrator');
      fireEvent.click(checkbox);

      const saveButton = screen.getByText('Save changes');
      expect(saveButton).not.toBeDisabled();
    });

    it('should show saving state while saving', async () => {
      mockUpdateSettings.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(mockSettings), 100)));

      render(<GeneralTab />);

      // Make a change
      const checkbox = screen.getByLabelText('Auto-start orchestrator');
      fireEvent.click(checkbox);

      // Click save
      const saveButton = screen.getByText('Save changes');
      fireEvent.click(saveButton);

      expect(screen.getByText('Saving...')).toBeInTheDocument();
    });
  });

  describe('Reset Functionality', () => {
    it('should call resetSection on reset confirmation', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      render(<GeneralTab />);

      const resetButton = screen.getByText('Reset to defaults');
      fireEvent.click(resetButton);

      await waitFor(() => {
        expect(mockResetSection).toHaveBeenCalledWith('general');
        expect(mockResetSection).toHaveBeenCalledWith('chat');
      });
    });

    it('should not call resetSection when reset is cancelled', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      render(<GeneralTab />);

      const resetButton = screen.getByText('Reset to defaults');
      fireEvent.click(resetButton);

      expect(mockResetSection).not.toHaveBeenCalled();
    });
  });
});

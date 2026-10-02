/**
 * Tests for InstalledSkills (Marketplace › Installed, former Settings › Skills).
 *
 * @module components/Marketplace/InstalledSkills.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InstalledSkills, skillMeta } from './InstalledSkills';
import { browserAutomationSummary } from './BrowserAutomationSettings';
import * as useSkillsHook from '../../hooks/useSkills';
import type { SkillSummary } from '../../types/skill.types';
import type { CrewlySettings } from '../../types/settings.types';

vi.mock('../../hooks/useSkills');

const mockUpdateSettings = vi.fn();
let mockSettings: { skills: CrewlySettings['skills'] } | null = null;
vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ settings: mockSettings, updateSettings: mockUpdateSettings }),
}));

function skill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: 'x',
    name: 'x',
    description: '',
    category: 'development',
    skillType: 'claude-skill',
    triggerCount: 0,
    roleCount: 0,
    isBuiltin: true,
    isEnabled: true,
    ...overrides,
  } as SkillSummary;
}

const mockSkills: SkillSummary[] = [
  skill({ id: 'file-operations', name: 'file-operations', description: 'Read, write, and manage files' }),
  skill({ id: 'git-operations', name: 'git-operations', description: 'Perform git version control operations' }),
  skill({
    id: 'my-scraper',
    name: 'my-scraper',
    description: 'Control web browsers programmatically',
    category: 'automation',
    isBuiltin: false,
    isEnabled: false,
    notices: [{ type: 'requirement', title: 'Needs Chrome', message: 'Install Chrome first', link: 'https://example.com', linkText: 'Get Chrome' }],
  }),
];

const hook = {
  skills: mockSkills,
  selectedSkill: null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  selectSkill: vi.fn(),
  clearSelection: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  execute: vi.fn(),
};

describe('InstalledSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings = null;
    vi.mocked(useSkillsHook.useSkills).mockReturnValue({ ...hook });
  });

  it('lists skills as compact rows with category and origin, and reports the count', () => {
    const onCount = vi.fn();
    render(<InstalledSkills onCountChange={onCount} />);
    expect(screen.getByText('file-operations')).toBeInTheDocument();
    expect(screen.getByText('my-scraper')).toBeInTheDocument();
    expect(screen.getAllByText('Development · Built-in')).toHaveLength(2);
    expect(screen.getByText('Automation · Custom')).toBeInTheDocument();
    expect(screen.getByTestId('installed-summary')).toHaveTextContent('3 installed · 1 disabled');
    expect(onCount).toHaveBeenCalledWith(3);
  });

  it('says Disabled only for disabled skills', () => {
    render(<InstalledSkills />);
    expect(screen.getAllByText('Disabled')).toHaveLength(1);
  });

  it('shows at most five rows, then Show all', () => {
    const many = Array.from({ length: 8 }, (_, i) => skill({ id: `s${i}`, name: `skill-${i}` }));
    vi.mocked(useSkillsHook.useSkills).mockReturnValue({ ...hook, skills: many });
    render(<InstalledSkills />);
    expect(screen.queryByText('skill-5')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8' }));
    expect(screen.getByText('skill-7')).toBeInTheDocument();
  });

  it('opens a row to show its description and setup notices', () => {
    render(<InstalledSkills />);
    fireEvent.click(screen.getByText('my-scraper'));
    const detail = screen.getByTestId('installed-skill-detail-my-scraper');
    expect(within(detail).getByText('Control web browsers programmatically')).toBeInTheDocument();
    expect(within(detail).getByText('Needs Chrome')).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: /Get Chrome/ })).toHaveAttribute('href', 'https://example.com');
  });

  it('enables a custom skill from its switch; built-in skills have none', async () => {
    const update = vi.fn().mockResolvedValue({});
    vi.mocked(useSkillsHook.useSkills).mockReturnValue({ ...hook, update });
    render(<InstalledSkills />);
    expect(screen.queryByLabelText('Enable file-operations')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Enable my-scraper'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('my-scraper', { isEnabled: true }));
  });

  it('filters by category through the Filter button and searches', () => {
    render(<InstalledSkills />);
    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByLabelText('Automation'));
    expect(vi.mocked(useSkillsHook.useSkills)).toHaveBeenLastCalledWith({ category: 'automation', search: undefined });
    fireEvent.change(screen.getByPlaceholderText('Search skills...'), { target: { value: 'git' } });
    expect(vi.mocked(useSkillsHook.useSkills)).toHaveBeenLastCalledWith({ category: 'automation', search: 'git' });
  });

  it('refreshes', () => {
    const refresh = vi.fn();
    vi.mocked(useSkillsHook.useSkills).mockReturnValue({ ...hook, refresh });
    render(<InstalledSkills />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh skills' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('opens the create editor from New Skill', () => {
    render(<InstalledSkills />);
    fireEvent.click(screen.getByRole('button', { name: /New Skill/ }));
    expect(screen.getByText('Create Skill')).toBeInTheDocument();
  });

  it('opens the edit editor from Edit', async () => {
    const selectSkill = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useSkillsHook.useSkills).mockReturnValue({ ...hook, selectSkill });
    render(<InstalledSkills />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit file-operations' }));
    await waitFor(() => expect(screen.getByText('Edit Skill')).toBeInTheDocument());
    expect(selectSkill).toHaveBeenCalledWith('file-operations');
  });

  it('deletes a custom skill from the ⋯ menu after confirming; built-ins cannot be deleted', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useSkillsHook.useSkills).mockReturnValue({ ...hook, remove });
    render(<InstalledSkills />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions for file-operations' }));
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for file-operations' }));

    fireEvent.click(screen.getByRole('button', { name: 'More actions for my-scraper' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(screen.getByText('Delete Skill')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('my-scraper'));
  });

  it('shows the error with a retry', () => {
    const refresh = vi.fn();
    vi.mocked(useSkillsHook.useSkills).mockReturnValue({ ...hook, skills: [], error: 'Failed to load skills', refresh });
    render(<InstalledSkills />);
    expect(screen.getByText('Error: Failed to load skills')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(refresh).toHaveBeenCalled();
  });

  it('shows an empty state with Create Skill', () => {
    vi.mocked(useSkillsHook.useSkills).mockReturnValue({ ...hook, skills: [] });
    render(<InstalledSkills />);
    expect(screen.getByText('No Skills Found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Skill/ })).toBeInTheDocument();
  });

  it('keeps Browser Automation settings in a collapsed section that saves', async () => {
    mockSettings = {
      skills: {
        enableBrowserAutomation: true,
        browserProfile: { headless: true, stealth: false, humanDelayMinMs: 300, humanDelayMaxMs: 1200 },
      } as CrewlySettings['skills'],
    };
    mockUpdateSettings.mockResolvedValue(undefined);
    render(<InstalledSkills />);
    const section = screen.getByTestId('browser-automation-settings');
    expect(within(section).getByText('On · headless')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: /Browser Automation/ }));
    fireEvent.click(screen.getByLabelText('Stealth Mode'));
    fireEvent.click(within(section).getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        skills: expect.objectContaining({ browserProfile: expect.objectContaining({ stealth: true }) }),
      }),
    );
  });
});

describe('helpers', () => {
  it('skillMeta names category, origin and web-page type', () => {
    expect(skillMeta(skill({ category: 'research', isBuiltin: false, skillType: 'web-page' }))).toBe('Research · Custom · Web Page');
    expect(skillMeta(skill({ category: 'browser' as SkillSummary['category'] }))).toBe('Browser · Built-in');
  });

  it('browserAutomationSummary says on/off and the modes', () => {
    expect(browserAutomationSummary({ enableBrowserAutomation: false } as CrewlySettings['skills'])).toBe('Off');
    expect(
      browserAutomationSummary({
        enableBrowserAutomation: true,
        browserProfile: { headless: true, stealth: true, humanDelayMinMs: 0, humanDelayMaxMs: 0 },
      } as CrewlySettings['skills']),
    ).toBe('On · headless · stealth');
  });
});

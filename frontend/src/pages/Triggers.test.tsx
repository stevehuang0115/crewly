/**
 * Schedules page (route /triggers) tests.
 *
 * @module pages/Triggers.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Triggers as TriggersPage } from './Triggers';
import type { CronTask } from '../types/cron-task.types';
import type { Trigger, EventSubscription } from '../types/trigger.types';
import type { Team } from '../types';

const mockUpdateTask = vi.fn();
const mockPause = vi.fn();
let mockCronTasks: CronTask[] = [];
let mockTriggers: Trigger[] = [];
let mockTeams: Team[] = [];
let mockSubs: EventSubscription[] = [];

vi.mock('../hooks/useTriggers', () => ({
  useTriggers: () => ({
    triggers: mockTriggers,
    engineStatus: { running: true, total: mockTriggers.length, byStatus: {}, byType: {} },
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    createTrigger: vi.fn(),
    pauseTrigger: mockPause,
    resumeTrigger: vi.fn(),
    cancelTrigger: vi.fn(),
    deleteTrigger: vi.fn(),
  }),
}));

vi.mock('../hooks/useCronTasks', () => ({
  useCronTasks: () => ({
    tasks: mockCronTasks,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    updateTask: mockUpdateTask,
    deleteTask: vi.fn(),
  }),
}));

vi.mock('../services/api.service', () => ({
  apiService: {
    getTeams: vi.fn(() => Promise.resolve(mockTeams)),
    getEventSubscriptions: vi.fn(() => Promise.resolve(mockSubs)),
  },
}));

/** The page reads its tab from the URL, so it renders inside a router. */
function Triggers({ path = '/triggers' }: { path?: string } = {}): JSX.Element {
  return (
    <MemoryRouter initialEntries={[path]}>
      <TriggersPage />
    </MemoryRouter>
  );
}

const IN_3H = new Date(Date.now() + 3 * 3600_000).toISOString();

/** The owner's nightly report, as the backend returns it after the fix. */
function dailyOps(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: '8c61ac27-1111-4000-8000-000000000000',
    type: 'time',
    config: { type: 'time', cronExpression: '30 22 * * *', timezone: 'America/New_York' },
    action: {
      createWorkItem: {
        type: 'delegate',
        target: 'ce-owen-ad0320ab',
        title: 'Nightly ops report',
        description: 'Run the daily-ops skill: news, forum topics, GA4 and inbox.',
      },
    },
    status: 'active',
    createdBy: 'agent',
    createdBySession: 'ce-owen-ad0320ab',
    internal: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    nextFireAt: IN_3H,
    fireCount: 2,
    maxFires: 58,
    maxIdleFires: 3,
    consecutiveIdleFires: 0,
    teamId: 'team-ce',
    name: 'daily-ops-nightly-2230',
    projectedLastFireAt: '2026-11-25T03:30:00.000Z',
    ...overrides,
  };
}

function internalTrigger(): Trigger {
  return dailyOps({
    id: 'esc-1',
    name: 'system:escalation',
    config: { type: 'time', cronExpression: '*/5 * * * *', timezone: 'UTC' },
    action: { runReconciler: true },
    createdBy: 'system',
    createdBySession: undefined,
    internal: true,
    teamId: undefined,
    maxFires: undefined,
  });
}

function makeCronTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'cron-1',
    cronExpression: '0 22 * * 5',
    timezone: 'America/New_York',
    targetAgent: 'ce-owen-ad0320ab',
    targetTeamId: 'team-ce',
    taskDescription: '【Weekly recap】\nSummarise the week.',
    createdBy: 'user',
    createdAt: '2026-09-01T00:00:00.000Z',
    enabled: true,
    lastRunAt: null,
    nextRunAt: IN_3H,
    ...overrides,
  };
}

/** Wait until the team list has loaded and rows sit in their team group. */
async function settled(): Promise<void> {
  await screen.findByRole('region', { name: 'CareerEngine' });
}

const ceTeam = {
  id: 'team-ce',
  name: 'CareerEngine',
  members: [{ id: 'm-owen', name: 'Owen', sessionName: 'ce-owen-ad0320ab', role: 'developer' }],
} as unknown as Team;

describe('Schedules page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCronTasks = [];
    mockTriggers = [];
    mockTeams = [ceTeam];
    mockSubs = [];
  });

  it('shows a clear empty state when nothing is scheduled', async () => {
    render(<Triggers />);
    expect(await screen.findByText('No schedules yet')).toBeInTheDocument();
  });

  it('shows the daily-ops trigger as a compact row: name, plain schedule, who, next run', async () => {
    mockTriggers = [dailyOps()];
    render(<Triggers />);
    await settled();

    expect(screen.getByText('daily-ops-nightly-2230')).toBeInTheDocument();
    const schedule = screen.getByText('Every day 22:30 ET');
    expect(schedule).toHaveAttribute('title', '30 22 * * * (America/New_York)');
    expect(screen.getByText('next in 3 h')).toBeInTheDocument();
    // Grouped under its team, run by the member's display name.
    expect(await screen.findByRole('region', { name: 'CareerEngine' })).toBeInTheDocument();
    expect(await screen.findByText('Owen')).toBeInTheDocument();
    // Run counts are detail, not row content (simplify rule: no numbers that need no action).
    expect(screen.queryByText(/Ran 2\/58/)).not.toBeInTheDocument();
    // Plenty of runs left — no renew warning.
    expect(screen.queryByText('Expiring soon — renew')).not.toBeInTheDocument();
  });

  it('keeps run counts and the projected end in the detail drawer', async () => {
    mockTriggers = [dailyOps()];
    render(<Triggers />);
    await settled();
    fireEvent.click(screen.getByText('daily-ops-nightly-2230'));
    const drawer = await screen.findByTestId('schedule-detail');
    expect(within(drawer).getByText(/Ran 2\/58 · 56 left/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Ends ~Nov 2[45]/)).toBeInTheDocument();
  });

  it('warns when 7 or fewer runs remain', async () => {
    mockTriggers = [dailyOps({ fireCount: 52 })];
    render(<Triggers />);
    await settled();
    expect(await screen.findByText('Expiring soon — renew')).toBeInTheDocument();
  });

  it('includes per-team cron tasks alongside cron triggers', async () => {
    mockCronTasks = [makeCronTask()];
    render(<Triggers />);
    await settled();
    expect(await screen.findByText('Weekly recap')).toBeInTheDocument();
    expect(screen.getByText('Every Friday 22:00 ET')).toBeInTheDocument();
  });

  it('hides internal triggers until "show system" is on', async () => {
    mockTriggers = [dailyOps(), internalTrigger()];
    render(<Triggers />);
    await settled();

    expect(await screen.findByText('daily-ops-nightly-2230')).toBeInTheDocument();
    expect(screen.queryByText('system:escalation')).not.toBeInTheDocument();
    expect(screen.getByText('1 system task hidden')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    expect(await screen.findByText('system:escalation')).toBeInTheDocument();
  });

  it('keeps the system-tasks switch behind the Filter button, as a removable chip', async () => {
    mockTriggers = [dailyOps(), internalTrigger()];
    render(<Triggers />);
    await settled();

    fireEvent.click(screen.getByTestId('filter-button'));
    fireEvent.click(screen.getByLabelText('System tasks'));
    expect(await screen.findByText('system:escalation')).toBeInTheDocument();
    expect(screen.getByText('Show: System tasks')).toBeInTheDocument();
  });

  it('cancels a schedule from the row ⋯ menu after confirming', async () => {
    mockTriggers = [dailyOps()];
    render(<Triggers />);
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for daily-ops-nightly-2230' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Cancel schedule/ }));
    expect(await screen.findByText('Cancel this schedule?')).toBeInTheDocument();
  });

  it('opens the tab named in ?tab=', async () => {
    mockTriggers = [dailyOps({ id: 'h1', name: 'old-one', status: 'cancelled' })];
    render(<Triggers path="/triggers?tab=history" />);
    expect(await screen.findByText('old-one')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the full description when a row is tapped', async () => {
    mockTriggers = [dailyOps()];
    render(<Triggers />);
    await settled();
    fireEvent.click(screen.getByText('daily-ops-nightly-2230'));
    const drawer = await screen.findByTestId('schedule-detail');
    expect(within(drawer).getByText('Run the daily-ops skill: news, forum topics, GA4 and inbox.')).toBeInTheDocument();
    expect(within(drawer).getByText('30 22 * * *')).toBeInTheDocument();
  });

  it('pauses from the row without opening it', async () => {
    mockTriggers = [dailyOps()];
    mockPause.mockResolvedValue(undefined);
    render(<Triggers />);
    await settled();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause daily-ops-nightly-2230' }));
    await waitFor(() => expect(mockPause).toHaveBeenCalledWith(dailyOps().id));
    expect(screen.queryByTestId('schedule-detail')).not.toBeInTheDocument();
  });

  it('toggles a cron task through the cron API', async () => {
    mockCronTasks = [makeCronTask()];
    mockUpdateTask.mockResolvedValue(undefined);
    render(<Triggers />);
    await settled();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Weekly recap' }));
    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledWith('cron-1', { enabled: false }));
  });

  it('lists one-shot follow-ups and event waits under Reminders', async () => {
    mockTriggers = [
      dailyOps(),
      dailyOps({
        id: 'fu-1',
        name: 'followup:abcd1234',
        config: { type: 'time', delayMs: 3600_000 },
        action: { createWorkItem: { title: 'Check PR #12', target: 'ce-owen-ad0320ab' } },
        maxFires: 1,
        fireCount: 0,
      }),
    ];
    mockSubs = [{ id: 'sub-1', eventType: 'agent:idle', filter: {}, oneShot: true, subscriberSession: 'crewly-orc', createdAt: '2026-09-30T00:00:00Z' }];
    render(<Triggers />);
    await settled();
    fireEvent.click(screen.getByRole('tab', { name: /Reminders/ }));
    // Auto-generated follow-up names fall back to the work item title.
    expect(await screen.findByText('Check PR #12')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Waiting on events' })).toBeInTheDocument();
  });

  it('lists History newest first, 20 per page', async () => {
    mockTriggers = Array.from({ length: 25 }, (_, i) => dailyOps({
      id: `old-${i}`,
      name: `old-schedule-${i}`,
      status: i % 2 ? 'cancelled' : 'exhausted',
      lastFiredAt: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
    }));
    render(<Triggers />);
    fireEvent.click(await screen.findByRole('tab', { name: /History/ }));

    expect(await screen.findByText('25 finished records')).toBeInTheDocument();
    // Newest first, 20 per page.
    expect(await screen.findByText('old-schedule-24')).toBeInTheDocument();
    expect(screen.queryByText('old-schedule-0')).not.toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('old-schedule-0')).toBeInTheDocument();
  });
});

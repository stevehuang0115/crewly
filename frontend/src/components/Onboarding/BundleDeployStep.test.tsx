/**
 * Tests for BundleDeployStep: the bundle summary and questions, the deploy
 * with live progress, pending steps with connect links, retry, the server's
 * missing answers, and handing the team back.
 *
 * @module components/Onboarding/BundleDeployStep.test
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BundleDeployStep } from './BundleDeployStep';
import { bundleService, BundleRequestError } from '../../services/bundle.service';
import type { BundleDeployment, BundleDetail } from '../../types/bundle.types';

vi.mock('../../services/bundle.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/bundle.service')>();
  return {
    BundleRequestError: actual.BundleRequestError,
    bundleService: { getBundle: vi.fn(), apply: vi.fn(), getJob: vi.fn() },
  };
});

const svc = vi.mocked(bundleService);

const BUNDLE: BundleDetail = {
  id: 'smb-marketing-team',
  name: 'Small-Business Marketing Team',
  label: '小老板营销团队',
  tagline: 't',
  description: 'd',
  status: 'ready',
  tier: 'pro',
  recommendedRuntime: 'crewly-agent',
  serverTier: 'entry',
  memberCount: 2,
  questionCount: 1,
  ownerSummary: '每天早上给你一份简报',
  ownerDoes: ['在手机上点头'],
  runtime: { recommended: 'crewly-agent' },
  server: { tier: 'entry' },
  questions: [{ id: 'business_name', label: '公司叫什么？', type: 'text', required: true }],
  teams: [{ key: 'main', name: '{{business_name}} 营销团队', members: [{ name: 'Ava', role: 'team-leader', title: '营销负责人' }] }],
  skills: [],
  connectors: [],
  schedules: [],
  firstWeek: [],
  channels: [],
};

/** A deployment snapshot. */
function deployment(status: BundleDeployment['status'], overrides: Partial<BundleDeployment> = {}): BundleDeployment {
  return {
    templateId: 'smb-marketing-team',
    jobId: 'job-1',
    status,
    runtime: 'claude-code',
    teams: [{ key: 'main', teamId: 'smb-marketing-team', name: '小周咖啡 营销团队' }],
    steps: [
      { id: 'team', label: '建团队', status: 'done', message: '团队已就绪' },
      { id: 'slack', label: '建 Slack 频道', status: status === 'running' ? 'queued' : 'pending', message: '还没连 Slack；连上后会自动建频道' },
    ],
    connectors: [{ id: 'canva', products: [], required: false, why: '做图', status: 'not_connected', connectPath: '/connections?platform=canva' }],
    firstWeek: [],
    ...overrides,
  };
}

/** Fill the question and deploy. */
async function answerAndDeploy(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/公司叫什么/), { target: { value: '小周咖啡' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('bundle-deploy'));
  });
}

describe('BundleDeployStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.getBundle.mockResolvedValue({ bundle: BUNDLE, deployment: null });
  });

  it('shows what the team does, what the owner does, the members and the questions', async () => {
    render(<BundleDeployStep templateId="smb-marketing-team" onBack={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByText('每天早上给你一份简报')).toBeInTheDocument();
    expect(screen.getByText('在手机上点头')).toBeInTheDocument();
    expect(screen.getByText(/Ava（营销负责人）/)).toBeInTheDocument();
    expect(screen.getByText('Crewly Agent（DeepSeek）')).toBeInTheDocument();
    expect(screen.getByText('部署「小老板营销团队」')).toBeInTheDocument();
  });

  it('deploys with the answers, follows the job and hands the main team back', async () => {
    svc.apply.mockResolvedValue(deployment('running'));
    svc.getJob.mockResolvedValue(deployment('partial'));
    const onDone = vi.fn();
    render(<BundleDeployStep templateId="smb-marketing-team" onBack={vi.fn()} onDone={onDone} pollIntervalMs={5} />);
    await answerAndDeploy();
    expect(svc.apply).toHaveBeenCalledWith('smb-marketing-team', { business_name: '小周咖啡' });
    expect(screen.getByText('正在部署「小老板营销团队」…')).toBeInTheDocument();
    await waitFor(() => expect(svc.getJob).toHaveBeenCalledWith('job-1'));
    expect(await screen.findByText('「小老板营销团队」已部署。')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-step-slack')).toHaveTextContent('稍后自动完成');
    expect(screen.getByText('canva')).toHaveAttribute('href', '/connections?platform=canva');
    fireEvent.click(screen.getByTestId('bundle-finish'));
    expect(onDone).toHaveBeenCalledWith({
      starterId: 'smb-marketing-team',
      teamId: 'smb-marketing-team',
      teamName: '小周咖啡 营销团队',
      suggestions: [],
      bundle: true,
    });
  });

  it('shows the server error and marks the questions it names', async () => {
    svc.apply.mockRejectedValue(new BundleRequestError('还没回答：公司叫什么？', 'invalid_answers', [{ id: 'business_name', label: '公司叫什么？', reason: '必填' }]));
    render(<BundleDeployStep templateId="smb-marketing-team" onBack={vi.fn()} onDone={vi.fn()} />);
    await answerAndDeploy();
    expect(screen.getByText('还没回答：公司叫什么？')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-missing-business_name')).toBeInTheDocument();
  });

  it('offers a retry when a step failed', async () => {
    const failed = deployment('partial', { steps: [{ id: 'skills', label: '装技能', status: 'failed', error: '1 个必需技能没装上' }] });
    svc.getBundle.mockResolvedValue({ bundle: BUNDLE, deployment: failed });
    svc.apply.mockResolvedValue(deployment('done', { connectors: [] }));
    render(<BundleDeployStep templateId="smb-marketing-team" onBack={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByText('1 个必需技能没装上')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('bundle-retry'));
    });
    expect(svc.apply).toHaveBeenCalledWith('smb-marketing-team', {});
    expect(screen.queryByTestId('bundle-retry')).not.toBeInTheDocument();
  });

  it('shows a load error with retry and back', async () => {
    svc.getBundle.mockRejectedValueOnce(new Error('没有找到方案'));
    const onBack = vi.fn();
    render(<BundleDeployStep templateId="x" onBack={onBack} onDone={vi.fn()} />);
    expect(await screen.findByText('没有找到方案')).toBeInTheDocument();
    fireEvent.click(screen.getByText('换一个'));
    expect(onBack).toHaveBeenCalled();
    svc.getBundle.mockResolvedValue({ bundle: BUNDLE, deployment: null });
    await act(async () => {
      fireEvent.click(screen.getByText('重试'));
    });
    expect(await screen.findByText('每天早上给你一份简报')).toBeInTheDocument();
  });
});

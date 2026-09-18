/**
 * Tests for KeyResultsSection — table rendering, measure / add / edit /
 * delete flows against the mocked API.
 *
 * @module components/Missions/KeyResultsSection.test
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyResultsSection } from './KeyResultsSection';
import type { KeyResult } from '../../types/mission.types';

const api = {
  getKeyResults: vi.fn(),
  createKeyResult: vi.fn(),
  updateKeyResult: vi.fn(),
  deleteKeyResult: vi.fn(),
  measureKeyResult: vi.fn(),
};
vi.mock('../../services/api.service', () => ({
  apiService: {
    getKeyResults: (...a: unknown[]) => api.getKeyResults(...a),
    createKeyResult: (...a: unknown[]) => api.createKeyResult(...a),
    updateKeyResult: (...a: unknown[]) => api.updateKeyResult(...a),
    deleteKeyResult: (...a: unknown[]) => api.deleteKeyResult(...a),
    measureKeyResult: (...a: unknown[]) => api.measureKeyResult(...a),
  },
}));

const kr: KeyResult = {
  id: 'kr-1',
  missionId: 'm-1',
  title: 'Reach $5k MRR',
  metricType: 'currency',
  baseline: 0,
  target: 5000,
  current: 1500,
  unit: '$',
  status: 'at_risk',
  measurementSource: 'manual',
  linkedWorkItemIds: [],
  measurements: [{ value: 1500, measuredAt: '2026-09-10T09:00:00.000Z', source: 'user' }],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-10T09:00:00.000Z',
};

describe('KeyResultsSection', () => {
  beforeEach(() => {
    Object.values(api).forEach((m) => m.mockReset());
    api.getKeyResults.mockResolvedValue([kr]);
  });

  it('renders the KR table with values, progress, status and source', async () => {
    render(<KeyResultsSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('kr-row-kr-1')).toBeInTheDocument());

    expect(screen.getByTestId('kr-values-kr-1')).toHaveTextContent('$0 → $1,500 → $5,000');
    expect(within(screen.getByTestId('kr-progress-kr-1')).getByTestId('progress-percent')).toHaveTextContent('30%');
    expect(screen.getByTestId('kr-status-kr-1')).toHaveTextContent('At risk');
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByTestId('kr-last-kr-1')).not.toHaveTextContent('never');
    expect(api.getKeyResults).toHaveBeenCalledWith('m-1');
  });

  it('shows the empty and error states', async () => {
    api.getKeyResults.mockResolvedValueOnce([]);
    const { unmount } = render(<KeyResultsSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('kr-empty')).toBeInTheDocument());
    unmount();

    api.getKeyResults.mockRejectedValueOnce(new Error('boom'));
    render(<KeyResultsSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('kr-error')).toHaveTextContent('boom'));
  });

  it('posts a measurement with value + note, reloads and notifies the parent', async () => {
    api.measureKeyResult.mockResolvedValue({ value: 2500, measuredAt: 'now', source: 'user' });
    const onChanged = vi.fn();
    render(<KeyResultsSection missionId="m-1" onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('kr-row-kr-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kr-measure-kr-1'));
    fireEvent.change(screen.getByTestId('kr-measure-value-kr-1'), { target: { value: '2500' } });
    fireEvent.change(screen.getByTestId('kr-measure-note-kr-1'), { target: { value: 'Sept invoice run' } });
    api.getKeyResults.mockResolvedValueOnce([{ ...kr, current: 2500, status: 'on_track' }]);
    fireEvent.click(screen.getByTestId('kr-measure-submit-kr-1'));

    await waitFor(() =>
      expect(api.measureKeyResult).toHaveBeenCalledWith('m-1', 'kr-1', { value: 2500, source: 'user', note: 'Sept invoice run' }),
    );
    await waitFor(() => expect(screen.getByTestId('kr-status-kr-1')).toHaveTextContent('On track'));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('kr-measure-form-kr-1')).toBeNull();
  });

  it('rejects a non-numeric measurement without calling the API', async () => {
    render(<KeyResultsSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('kr-row-kr-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('kr-measure-kr-1'));
    fireEvent.change(screen.getByTestId('kr-measure-value-kr-1'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('kr-measure-submit-kr-1'));
    await waitFor(() => expect(screen.getByTestId('kr-action-error')).toHaveTextContent(/must be a number/));
    expect(api.measureKeyResult).not.toHaveBeenCalled();
  });

  it('creates a KR from the add form', async () => {
    api.createKeyResult.mockResolvedValue({ ...kr, id: 'kr-2' });
    render(<KeyResultsSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('kr-row-kr-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kr-add-toggle'));
    fireEvent.change(screen.getByTestId('kr-new-title'), { target: { value: 'Cut P95 latency' } });
    fireEvent.change(screen.getByTestId('kr-new-metric'), { target: { value: 'number' } });
    fireEvent.change(screen.getByTestId('kr-new-baseline'), { target: { value: '800' } });
    fireEvent.change(screen.getByTestId('kr-new-target'), { target: { value: '200' } });
    fireEvent.change(screen.getByTestId('kr-new-unit'), { target: { value: 'ms' } });
    fireEvent.change(screen.getByTestId('kr-new-source'), { target: { value: 'skill_output' } });
    fireEvent.click(screen.getByTestId('kr-new-submit'));

    await waitFor(() =>
      expect(api.createKeyResult).toHaveBeenCalledWith('m-1', {
        title: 'Cut P95 latency',
        metricType: 'number',
        baseline: 800,
        target: 200,
        unit: 'ms',
        measurementSource: 'skill_output',
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('kr-add-form')).toBeNull());
  });

  it('blocks creating a KR whose baseline equals its target', async () => {
    render(<KeyResultsSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('kr-row-kr-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('kr-add-toggle'));
    fireEvent.change(screen.getByTestId('kr-new-title'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('kr-new-baseline'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('kr-new-target'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('kr-new-submit'));
    await waitFor(() => expect(screen.getByTestId('kr-action-error')).toHaveTextContent(/must be different/));
    expect(api.createKeyResult).not.toHaveBeenCalled();
  });

  it('sends only the changed fields when editing a KR', async () => {
    api.updateKeyResult.mockResolvedValue({ ...kr, target: 8000 });
    render(<KeyResultsSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('kr-row-kr-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kr-edit-kr-1'));
    fireEvent.change(screen.getByTestId('kr-edit-target-kr-1'), { target: { value: '8000' } });
    fireEvent.click(screen.getByTestId('kr-edit-submit-kr-1'));

    await waitFor(() => expect(api.updateKeyResult).toHaveBeenCalledWith('m-1', 'kr-1', { target: 8000 }));
    await waitFor(() => expect(screen.queryByTestId('kr-edit-form-kr-1')).toBeNull());
  });

  it('deletes a KR after confirmation', async () => {
    api.deleteKeyResult.mockResolvedValue(undefined);
    render(<KeyResultsSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('kr-row-kr-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('kr-delete-kr-1'));
    api.getKeyResults.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => expect(api.deleteKeyResult).toHaveBeenCalledWith('m-1', 'kr-1'));
    await waitFor(() => expect(screen.getByTestId('kr-empty')).toBeInTheDocument());
  });

  it('surfaces a server error from a mutation', async () => {
    api.measureKeyResult.mockRejectedValue(new Error('Key Result not found'));
    render(<KeyResultsSection missionId="m-1" />);
    await waitFor(() => expect(screen.getByTestId('kr-row-kr-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('kr-measure-kr-1'));
    fireEvent.click(screen.getByTestId('kr-measure-submit-kr-1'));
    await waitFor(() => expect(screen.getByTestId('kr-action-error')).toHaveTextContent('Key Result not found'));
  });
});

import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import { AttentionService } from './attention.service.js';

vi.mock('fs');

const mockedFs = fs as unknown as vi.Mocked<typeof fs>;

describe('AttentionService', () => {
	let service: AttentionService;
	const sessionName = 'crewly-product-sam-test';

	beforeEach(() => {
		service = new AttentionService();
		vi.resetAllMocks();
		mockedFs.mkdirSync.mockReturnValue(undefined);
		mockedFs.writeFileSync.mockReturnValue(undefined);
	});

	describe('getAttention', () => {
		it('should return empty default when file does not exist', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = await service.getAttention(sessionName);

			expect(result.focus).toEqual([]);
			expect(result.suppressed).toEqual([]);
		});

		it('should return persisted data when file exists', async () => {
			const data = {
				focus: ['prompt modules'],
				suppressed: ['old auth'],
				lastPruned: '2026-03-19',
				focusTimestamps: { 'prompt modules': '2026-03-19' },
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const result = await service.getAttention(sessionName);

			expect(result.focus).toEqual(['prompt modules']);
			expect(result.suppressed).toEqual(['old auth']);
		});
	});

	describe('getFocus', () => {
		it('should return focus items', async () => {
			const data = { focus: ['a', 'b'], suppressed: [], lastPruned: '', focusTimestamps: {} };
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const focus = await service.getFocus(sessionName);

			expect(focus).toEqual(['a', 'b']);
		});
	});

	describe('setFocus', () => {
		it('should replace focus items and set timestamps', async () => {
			mockedFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT');
			});

			await service.setFocus(sessionName, ['task A', 'task B']);

			const writeCall = mockedFs.writeFileSync.mock.calls[0];
			const saved = JSON.parse(writeCall[1] as string);
			expect(saved.focus).toEqual(['task A', 'task B']);
			expect(saved.focusTimestamps['task A']).toBeTruthy();
			expect(saved.focusTimestamps['task B']).toBeTruthy();
		});
	});

	describe('suppress', () => {
		it('should add item to suppressed list', async () => {
			const data = { focus: ['a', 'b'], suppressed: [], lastPruned: '', focusTimestamps: { a: '2026-03-19', b: '2026-03-19' } };
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			await service.suppress(sessionName, 'old topic');

			const writeCall = mockedFs.writeFileSync.mock.calls[0];
			const saved = JSON.parse(writeCall[1] as string);
			expect(saved.suppressed).toContain('old topic');
		});

		it('should remove suppressed item from focus', async () => {
			const data = { focus: ['a', 'b'], suppressed: [], lastPruned: '', focusTimestamps: { a: '2026-03-19', b: '2026-03-19' } };
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			await service.suppress(sessionName, 'a');

			const writeCall = mockedFs.writeFileSync.mock.calls[0];
			const saved = JSON.parse(writeCall[1] as string);
			expect(saved.focus).not.toContain('a');
			expect(saved.suppressed).toContain('a');
		});

		it('should not add duplicate suppressed items', async () => {
			const data = { focus: [], suppressed: ['old'], lastPruned: '', focusTimestamps: {} };
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			await service.suppress(sessionName, 'old');

			const writeCall = mockedFs.writeFileSync.mock.calls[0];
			const saved = JSON.parse(writeCall[1] as string);
			expect(saved.suppressed).toEqual(['old']);
		});
	});

	describe('prune', () => {
		it('should remove focus items older than 14 days', async () => {
			const old = new Date();
			old.setDate(old.getDate() - 20);
			const recent = new Date();
			recent.setDate(recent.getDate() - 5);

			const data = {
				focus: ['stale item', 'fresh item'],
				suppressed: [],
				lastPruned: '',
				focusTimestamps: {
					'stale item': old.toISOString().split('T')[0],
					'fresh item': recent.toISOString().split('T')[0],
				},
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const pruned = await service.prune(sessionName);

			expect(pruned).toBe(1);
			const writeCall = mockedFs.writeFileSync.mock.calls[0];
			const saved = JSON.parse(writeCall[1] as string);
			expect(saved.focus).toEqual(['fresh item']);
			expect(saved.lastPruned).toBeTruthy();
		});

		it('should prune items without timestamps', async () => {
			const data = {
				focus: ['no-timestamp-item'],
				suppressed: [],
				lastPruned: '',
				focusTimestamps: {},
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const pruned = await service.prune(sessionName);

			expect(pruned).toBe(1);
		});

		it('should return 0 when nothing to prune', async () => {
			const recent = new Date().toISOString().split('T')[0];
			const data = {
				focus: ['active'],
				suppressed: [],
				lastPruned: '',
				focusTimestamps: { active: recent },
			};
			mockedFs.readFileSync.mockReturnValue(JSON.stringify(data));

			const pruned = await service.prune(sessionName);

			expect(pruned).toBe(0);
		});
	});
});

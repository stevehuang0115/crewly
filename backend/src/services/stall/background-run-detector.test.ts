/**
 * Tests for the background-run text heuristics (crewly#1363 kind c).
 *
 * @module services/stall/background-run-detector.test
 */

import { detectBackgroundRun, hasDeliverable, isRunFinishedReport } from './background-run-detector.js';

describe('detectBackgroundRun', () => {
	it.each([
		['已经开跑了，预计 1 小时左右出结果。', 3600_000],
		['视频已经在渲染，大概 40 分钟。', 40 * 60_000],
		['子任务在做了。预计一个半小时。', 90 * 60_000],
		['后台跑着呢，两小时左右看结果', 2 * 3600_000],
		['Kicked off the render, about 40 min.', 40 * 60_000],
		['Started the run for the explainer; should take an hour.', 3600_000],
		['It is rendering now — roughly 2 hours.', 2 * 3600_000],
		['Running in the background. ETA 30 minutes.', 30 * 60_000],
		['Spun up a sub-agent for the cut; 1.5 到 2 小时', 2 * 3600_000],
	])('registers %j with its estimate', (text, estimateMs) => {
		const run = detectBackgroundRun(text);
		expect(run).not.toBeNull();
		expect(run?.estimateMs).toBe(estimateMs);
		expect(run?.head.length).toBeLessThanOrEqual(160);
	});

	it('reads the duration from the neighbouring sentence', () => {
		expect(detectBackgroundRun('渲染已经开跑。预计 1 小时左右。')?.estimateMs).toBe(3600_000);
		expect(detectBackgroundRun('About 25 minutes for this one. Kicked off the batch.')?.estimateMs).toBe(25 * 60_000);
	});

	it.each([
		'Kicked off the render.',
		'已经开跑了。',
		'渲染完了，文件在这里。预计用了 1 小时。',
		'要不要我现在开跑？预计 1 小时',
		'我明天开始做，大概 1 小时',
		'Here is the plan: three clips, one hour each.',
		'Done — the render finished after about an hour.',
		'',
	])('does not register %j', (text) => {
		expect(detectBackgroundRun(text)).toBeNull();
	});

	it('clips a long announcement', () => {
		const long = `已经开跑了，预计 1 小时左右，${'细节'.repeat(120)}`;
		expect(detectBackgroundRun(long)?.head.length).toBe(160);
	});
});

describe('submitted async jobs register with no duration (crewly#1386)', () => {
	it.each([
		'三条片段已经提交到 Flow 了，作为第 3 步的预览。',
		'Submitted three Veo clips for the fight scene.',
		'视频已提交，让它们跑完再对比。',
		'Queued 3 renders on Flow.',
	])('registers %j with no estimate', (text) => {
		const run = detectBackgroundRun(text);
		expect(run).not.toBeNull();
		expect(run?.estimateMs).toBeNull();
	});

	it('takes the duration when one is named', () => {
		expect(detectBackgroundRun('三条片段已经提交到 Flow。预计 40 分钟。')?.estimateMs).toBe(40 * 60_000);
	});

	it('a later timed run in the same post wins over an untimed submission', () => {
		expect(detectBackgroundRun('片段已提交到 Flow。另外后台在跑转码，大概 20 分钟。')?.estimateMs).toBe(20 * 60_000);
	});

	it.each([
		'PR 已经提交了。',
		'I submitted the form.',
		'表单已提交。',
		'要不要我把视频提交到 Flow？',
		'三条片段已经提交到 Flow，都生成完了，见附件。',
	])('does not register %j', (text) => {
		expect(detectBackgroundRun(text)).toBeNull();
	});
});

describe('isRunFinishedReport', () => {
	it.each(['跑完了，见附件', '渲染完成了', 'Done, file attached', 'The render failed with OOM', '挂了，重跑中', 'ready: https://x/y.mp4'])('%j is a report', (t) => {
		expect(isRunFinishedReport(t)).toBe(true);
	});
	it.each(['还在跑', 'still rendering, 20 more minutes', '跑完了吗？', '', '让它们跑完，对比后看差多少。', "Once they are done I'll compare them."])('%j is not', (t) => {
		expect(isRunFinishedReport(t)).toBe(false);
	});
});

describe('hasDeliverable', () => {
	it('counts attachments, links and file names', () => {
		expect(hasDeliverable({ content: 'here', attachmentCount: 1 })).toBe(true);
		expect(hasDeliverable({ content: 'see https://drive.google.com/x' })).toBe(true);
		expect(hasDeliverable({ content: 'saved as W41-final.mp4' })).toBe(true);
	});
	it('a plain status line is not a deliverable', () => {
		expect(hasDeliverable({ content: 'still working on it', attachmentCount: 0 })).toBe(false);
	});
});

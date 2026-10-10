import { detectStatedIntent, extractDeliverables } from './stated-intent.js';

describe('detectStatedIntent', () => {
	it.each([
		"I'm breaking down the reference shot list now, then building the crab version, posting to #awesome-videos",
		"I'm starting on the replica now.",
		'The next step is breaking the reference video into a shot list.',
		"I'll start building the crab version right away.",
		'Starting now on the schedule video.',
		'我现在开始拆参考视频的分镜',
		'接下来我会把螃蟹版做出来',
		'下一步是拆分镜',
		'做好发你',
		'马上开始做第二个视频',
	])('flags %s', (text) => {
		expect(detectStatedIntent(text)).not.toBeNull();
	});

	it.each([
		'Done — the video is attached.',
		'已完成，视频在 #awesome-videos。',
		'I finished the replica and posted it.',
		'Which Xiaohongshu video did you mean?',
		"I'll wait for your OK before I start.",
		'Once you confirm the style, I can build it.',
		'等你确认后我再做',
		'我们之前做过一版，在 out/ 目录里。',
		'',
	])('does not flag %s', (text) => {
		expect(detectStatedIntent(text)).toBeNull();
	});

	it('returns the sentence that states it, clipped', () => {
		const r = detectStatedIntent('Got your note. I am now rebuilding the intro. Details follow.');
		expect(r?.sentence).toBe('I am now rebuilding the intro.');
	});
});

describe('extractDeliverables', () => {
	it('reads a numbered list', () => {
		expect(extractDeliverables('Please make:\n1. a schedule video\n2. a hand-drawn Claw replica\n3. a dashboard replica')).toEqual([
			'a schedule video',
			'a hand-drawn Claw replica',
			'a dashboard replica',
		]);
	});

	it('reads inline numbering', () => {
		expect(extractDeliverables('I need (1) the schedule video (2) the Claw replica (3) the dashboard replica')).toHaveLength(3);
	});

	it('reads "one … another …"', () => {
		const items = extractDeliverables('Make one in the SMB style, another that copies the hand-drawn Claw video');
		expect(items).toHaveLength(2);
		expect(items[1]).toMatch(/hand-drawn Claw/);
	});

	it('reads a bare count in Chinese and English', () => {
		expect(extractDeliverables('帮我做三个视频')).toEqual(['视频 1 of 3', '视频 2 of 3', '视频 3 of 3']);
		expect(extractDeliverables('Please produce two videos for the launch')).toHaveLength(2);
	});

	it('returns [] for a single ask', () => {
		expect(extractDeliverables('Can you make a video about the schedule feature?')).toEqual([]);
		expect(extractDeliverables('')).toEqual([]);
		expect(extractDeliverables('I need 2 or 3 options')).toEqual([]);
	});
});

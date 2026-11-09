/**
 * Tests for the "X is doing it" claim detector (crewly#1362).
 *
 * @module services/stall/claim-check.test
 */

import { claimIndex, claimNudgeText, claimPatternsFor, detectTeammateClaims, isPlannedHandOff } from './claim-check.js';

const members = [
	{ name: 'Pia', session: 'flopost-pia' },
	{ name: 'Dana', session: 'flopost-dana' },
	{ name: 'Ella', session: 'flopost-ella' },
	{ name: '小龙', session: 'flopost-xiaolong' },
	{ name: 'Dex', session: 'flopost-dex' },
	{ name: 'Owen', session: 'ce-owen' },
];
const speaker = 'flopost-ella';

describe('detectTeammateClaims', () => {
	it('finds the 2026-10-16 claim (Ella: 视频已经是 Pia 在做了)', () => {
		const claims = detectTeammateClaims('对，视频已经是 Pia 在做了，录屏 + AI 配音，75 秒。这三样好了我先看一遍再发你。', members, speaker);
		expect(claims).toEqual([{ member: 'flopost-pia', memberName: 'Pia', sentence: expect.stringContaining('Pia 在做了') }]);
	});

	it.each([
		['交给 Pia 了，今天出。', 'flopost-pia'],
		['让 Dana 去做录屏。', 'flopost-dana'],
		['小龙负责这块。', 'flopost-xiaolong'],
		['Pia is already on it.', 'flopost-pia'],
		['Dana is working on the screen recording.', 'flopost-dana'],
		["Pia's making the full version now.", 'flopost-pia'],
		['I handed it to Dana this morning.', 'flopost-dana'],
		['Assigned the stills to Pia.', 'flopost-pia'],
	])('%j names %s', (text, member) => {
		expect(detectTeammateClaims(text, members, speaker).map((c) => c.member)).toEqual([member]);
	});

	it.each([
		'让 Pia 做可以吗？',
		'Should Pia take it?',
		'不是 Pia 在做，是我在做。',
		'Pia is not on it yet.',
		'Pia 的视频昨天发过了。',
		'I will do it myself now.',
		'Pianist videos are trending.',
		'',
	])('does not claim from %j', (text) => {
		expect(detectTeammateClaims(text, members, speaker)).toEqual([]);
	});

	// 2026-10-23: Pia was nudged four times in a day for plans gated on the
	// owner's approval, and each time posted a correction in the owner's
	// thread (crewly#1427 item 5). These are the sentences, verbatim.
	it.each([
		'你看过说可以,我再交给 Dex 走发版决策卡。',
		'你选好音乐、说可以,我再交给 Dex 走发版决策卡。',
		'你看过说可以,我交给 Dex 走发版,他给你发决策卡,你点了才上线。',
		'另外这版 logo 小人物的引擎改动还没提交,会随这次一起交给 Dex。',
		'你说改，我就做成改动交给 Owen，跟下一次上线一起带，不会单独动线上。',
		'最后「放进 Flopost」:卡交给 Dex 带进下一次发版,他给你发决策卡,你点了才上线。',
		'等你定了我让 Dana 去做录屏。',
		'如果你同意，由 Pia 负责这块。',
		'Once you approve, Pia will be doing the full version.',
		"If you like it, I'll pass it over to Dana — I would have handed it to Dana today otherwise.",
	])('a planned hand-off is not a claim: %j', (text) => {
		expect(detectTeammateClaims(text, members, speaker)).toEqual([]);
	});

	it.each([
		['交给 Pia 了，你点一下看看。', 'flopost-pia'],
		['刚才让 Dana 去做录屏了。', 'flopost-dana'],
		['Pia 在做，再等等。', 'flopost-pia'],
		['Pia will be doing it; I just handed it over.', 'flopost-pia'],
		['I handed it to Dana, then went back to the stills.', 'flopost-dana'],
		['After the review I handed it to Dana.', 'flopost-dana'],
	])('words after the hand-off do not make it a plan: %j', (text, member) => {
		expect(detectTeammateClaims(text, members, speaker).map((c) => c.member)).toEqual([member]);
	});

	it('claimIndex finds the earliest match; isPlannedHandOff reads only the text before it', () => {
		const res = claimPatternsFor('Pia');
		expect(claimIndex('没有人。', res)).toBe(-1);
		expect(claimIndex('先让 Pia 做，Pia 在做。', res)).toBe(1);
		expect(isPlannedHandOff('我再交给 Pia。', 2)).toBe(true);
		expect(isPlannedHandOff('交给 Pia 了，再说。', 0)).toBe(false);
		expect(isPlannedHandOff('刚才交给 Pia 了。', 2)).toBe(false);
	});

	it('never claims about the speaker, and ignores names outside the team', () => {
		expect(detectTeammateClaims('Ella is doing it.', members, speaker)).toEqual([]);
		expect(detectTeammateClaims('Rex 在做。', members, speaker)).toEqual([]);
		expect(detectTeammateClaims('Rex 在做。', [], speaker)).toEqual([]);
	});

	it('reports each teammate once, in order', () => {
		const claims = detectTeammateClaims('Pia 在做视频。Dana 在做录屏。Pia 还在做配音。', members, speaker);
		expect(claims.map((c) => c.member)).toEqual(['flopost-pia', 'flopost-dana']);
	});

	it('escapes regex characters in names', () => {
		expect(claimPatternsFor('A.J. (Ops)')).toHaveLength(4);
		expect(detectTeammateClaims('A.J. (Ops) is handling it.', [{ name: 'A.J. (Ops)', session: 'aj' }], speaker).map((c) => c.member)).toEqual(['aj']);
	});
});

describe('claimNudgeText', () => {
	it('names the teammate, quotes the sentence and asks for a delegation or a correction', () => {
		const text = claimNudgeText('Pia', '视频已经是 Pia 在做了');
		expect(text).toMatch(/^\[CLAIM-CHECK\] You told the owner Pia is doing it/);
		expect(text).toContain('nothing is assigned to Pia');
		expect(text).toContain('Delegate it now, or fix the wording in your next reply if you misspoke.');
		expect(text).toMatch(/If it was only a plan for later, do nothing — and never post about this note in the owner's thread\.$/);
	});
});

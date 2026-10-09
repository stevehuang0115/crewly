import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { postBootOwnerAlert } from './boot-owner-alert.js';

describe('postBootOwnerAlert', () => {
	let home: string;
	beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'boa-')); });
	afterEach(() => rmSync(home, { recursive: true, force: true }));
	const target = async () => ({ botToken: 'xoxb-t', channel: 'U1' });
	const okFetch = () => jest.fn().mockResolvedValue({ json: async () => ({ ok: true }) }) as unknown as typeof fetch;

	it('posts the line once per day', async () => {
		const f = okFetch();
		let t = 1_000_000;
		expect(await postBootOwnerAlert('line', home, target, f, () => t)).toBe(true);
		expect(await postBootOwnerAlert('line', home, target, f, () => t + 60_000)).toBe(false);
		expect(await postBootOwnerAlert('line', home, target, f, () => t + 25 * 3600_000)).toBe(true);
		expect(f).toHaveBeenCalledTimes(2);
		const body = JSON.parse((f as jest.Mock).mock.calls[0][1].body);
		expect(body).toEqual({ channel: 'U1', text: 'line' });
	});

	it('never throws: no Slack set up, or Slack failing', async () => {
		expect(await postBootOwnerAlert('a', home, async () => null)).toBe(false);
		const bad = jest.fn().mockRejectedValue(new Error('net')) as unknown as typeof fetch;
		expect(await postBootOwnerAlert('b', home, target, bad)).toBe(false);
	});
});

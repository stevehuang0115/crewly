import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { readRecordSources, renderRecord, WikiRecordSyncService, type RecordSource, type RecordSyncDeps } from './wiki-record-sync.service.js';
import type { WikiIngestInput } from './wiki-ingest.service.js';

const SOURCE: RecordSource = {
	appId: 'au35rbdmzt',
	collection: 'customers',
	folder: 'customers',
	titleFields: ['company', 'name'],
	aliasFields: ['company', 'name'],
	summaryFields: ['stage', 'nextStep'],
	tags: ['customer'],
};

const ROBOHUB = {
	id: 'robohub-xin',
	data: {
		company: 'RoboHub',
		name: '刘欣（Xin）',
		stage: '在聊',
		nextStep: '等 Xin 在董事会后联系',
		timeline: [
			{ date: '2026-10-09', label: '会议（约 46 分钟）' },
			{ date: '2026-11-11', label: '董事会决定三期开发计划' },
		],
		needs: 'Phase 3 开工前和开工中，要有懂技术的顾问定方向；先搬数据（新加坡搬回美国）并做合规和安全，然后做营销数据分析（BI）。会上 Xin 请 Steve 写 proposal，从小处开始，按小时或顾问费都可以。Atlas 的 proposal 草稿：两周付费技术评估（数据搬迁与合规方案 + Phase 3 范围重排），之后接月度顾问；不报开发价。',
		_internal: 'skip me',
		empty: '',
	},
};

describe('renderRecord', () => {
	it('turns a record into an entity page: title, summary, names, facts and sections', () => {
		const page = renderRecord(SOURCE, ROBOHUB);
		expect(page).not.toBeNull();
		expect(page?.relativePath).toBe('llm-curated/customers/robohub-xin.md');
		expect(page?.title).toBe('RoboHub · 刘欣（Xin）');
		expect(page?.summary).toBe('在聊; 等 Xin 在董事会后联系');
		expect(page?.aliases).toEqual(expect.arrayContaining(['RoboHub', '刘欣', 'Xin', '刘欣（Xin）']));
		expect(page?.body).toContain('- **stage**: 在聊');
		expect(page?.body).toContain('## timeline\n- 2026-10-09 会议（约 46 分钟）\n- 2026-11-11 董事会决定三期开发计划');
		expect(page?.body).toContain('## needs\nPhase 3');
		expect(page?.body).not.toContain('skip me');
		expect(page?.body).toContain('au35rbdmzt / customers / robohub-xin');
	});

	it('returns null without a title or a usable id, and clips a huge field', () => {
		expect(renderRecord(SOURCE, { id: 'x', data: { stage: '在聊' } })).toBeNull();
		expect(renderRecord(SOURCE, { id: '///', data: { name: 'A B' } })).toBeNull();
		const big = renderRecord(SOURCE, { id: 'big', data: { name: 'Big Co', photo: 'x'.repeat(9000) } });
		expect(big?.body.length).toBeLessThan(4400);
	});
});

describe('readRecordSources', () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(path.join(os.tmpdir(), 'record-sync-'));
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true, maxRetries: 3 });
	});

	it('is empty without a file, and reports a broken one', () => {
		expect(readRecordSources(vault)).toEqual({ sources: [], problems: [] });
		writeFileSync(path.join(vault, 'record-sources.json'), '{ nope');
		expect(readRecordSources(vault).problems[0]).toContain('not valid JSON');
	});

	it('keeps valid sources and names what is wrong with the rest', () => {
		writeFileSync(
			path.join(vault, 'record-sources.json'),
			JSON.stringify({
				sources: [
					{ appId: 'au35rbdmzt', collection: 'customers', folder: 'customers', titleFields: ['name'] },
					{ appId: 'au35rbdmzt', collection: 'customers', folder: 'secrets', titleFields: ['name'] },
					{ appId: '../etc', collection: 'customers', folder: 'people', titleFields: ['name'] },
					{ appId: 'a1', collection: 'c1', folder: 'people', titleFields: [] },
				],
			}),
		);
		const { sources, problems } = readRecordSources(vault);
		expect(sources).toEqual([{ appId: 'au35rbdmzt', collection: 'customers', folder: 'customers', titleFields: ['name'], aliasFields: [], summaryFields: [], tags: [] }]);
		expect(problems).toHaveLength(3);
	});
});

describe('WikiRecordSyncService', () => {
	let vault: string;

	/**
	 * A service over fakes; `ingest` writes the page the way the wiki would.
	 *
	 * @param overrides - Dependency overrides
	 * @returns The service and its spies
	 */
	function make(overrides: Partial<RecordSyncDeps> = {}) {
		const ingested: WikiIngestInput[] = [];
		const deps: RecordSyncDeps = {
			readerFor: jest.fn(async () => 'crewly-marketing-lead'),
			listDocs: jest.fn(async () => ({ docs: [ROBOHUB] })),
			ingest: jest.fn(async (input: WikiIngestInput) => {
				ingested.push(input);
				const file = path.join(input.vaultPath, input.targetRelativePath as string);
				mkdirSync(path.dirname(file), { recursive: true });
				writeFileSync(file, `---\ntitle: ${input.title}\n---\n# ${input.title}\n\n${input.sourceBody}\n`);
				return { ok: true as const, pagesWritten: [input.targetRelativePath as string], logEntry: '', frozenPathsTouched: [] };
			}),
			...overrides,
		};
		return { service: new WikiRecordSyncService(deps), deps, ingested };
	}

	beforeEach(() => {
		vault = mkdtempSync(path.join(os.tmpdir(), 'record-sync-'));
		writeFileSync(path.join(vault, 'record-sources.json'), JSON.stringify({ sources: [SOURCE] }));
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true, maxRetries: 3 });
	});

	it('writes one page per record, read as the vault\'s team lead', async () => {
		const { service, deps, ingested } = make();
		const report = await service.syncVault(vault);

		expect(report.written).toEqual(['llm-curated/customers/robohub-xin.md']);
		expect(deps.listDocs).toHaveBeenCalledWith('au35rbdmzt', 'customers', { limit: 200 }, 'crewly-marketing-lead');
		expect(ingested[0]).toMatchObject({ replace: true, keepBecause: 'hard_fact', sourceRef: 'app:au35rbdmzt/customers/robohub-xin', tags: ['customer'] });
	});

	it('leaves a current page alone, rewrites a changed record, and keeps hand-written notes', async () => {
		const first = make();
		await first.service.syncVault(vault);

		const same = make();
		const unchanged = await same.service.syncVault(vault);
		expect(unchanged.unchanged).toBe(1);
		expect(same.deps.ingest).not.toHaveBeenCalled();

		const file = path.join(vault, 'llm-curated/customers/robohub-xin.md');
		writeFileSync(file, `${readFileSync(file, 'utf8')}\n## Notes\nPrefers WeChat over email.\n`);
		const changed = make({ listDocs: jest.fn(async () => ({ docs: [{ ...ROBOHUB, data: { ...ROBOHUB.data, stage: '已签约' } }] })) });
		const report = await changed.service.syncVault(vault);

		expect(report.written).toHaveLength(1);
		expect(changed.ingested[0].sourceBody).toContain('- **stage**: 已签约');
		expect(changed.ingested[0].sourceBody).toContain('## Notes\nPrefers WeChat over email.');
	});

	it('follows pages of a collection and stops when the cursor does not move', async () => {
		const listDocs = jest
			.fn()
			.mockResolvedValueOnce({ docs: [ROBOHUB], next: 'robohub-xin' })
			.mockResolvedValueOnce({ docs: [{ id: 'jack', data: { name: 'Jack', company: 'Hanami' } }], next: 'jack' })
			.mockResolvedValueOnce({ docs: [], next: 'jack' });
		const { service } = make({ listDocs });

		const report = await service.syncVault(vault);
		expect(report.written).toHaveLength(2);
		expect(listDocs).toHaveBeenNthCalledWith(2, 'au35rbdmzt', 'customers', { limit: 200, after: 'robohub-xin' }, 'crewly-marketing-lead');
	});

	it('copies nothing without a team lead, and reports an App it may not read instead of throwing', async () => {
		const noLead = make({ readerFor: jest.fn(async () => null) });
		const report = await noLead.service.syncVault(vault);
		expect(report.errors[0]).toContain('no team lead');
		expect(noLead.deps.listDocs).not.toHaveBeenCalled();

		const refused = make({ listDocs: jest.fn(async () => Promise.reject(new Error('not_your_app'))) });
		expect((await refused.service.syncVault(vault)).errors).toEqual(['au35rbdmzt/customers: not_your_app']);
	});

	it('records a page the wiki refused, and skips vaults that list nothing', async () => {
		const refused = make({ ingest: jest.fn(async () => ({ ok: false as const, reason: 'secret_detected' as const, message: 'x', details: [] })) });
		expect((await refused.service.syncVault(vault)).skipped).toEqual([{ ref: 'au35rbdmzt/customers/robohub-xin', reason: 'secret_detected' }]);

		const empty = mkdtempSync(path.join(os.tmpdir(), 'record-sync-empty-'));
		const { service, deps } = make();
		expect(await service.syncVaults([empty])).toEqual([]);
		expect(deps.readerFor).not.toHaveBeenCalled();
		rmSync(empty, { recursive: true, force: true, maxRetries: 3 });
	});
});

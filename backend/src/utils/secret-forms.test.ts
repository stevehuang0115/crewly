/**
 * Tests for the written forms of a labelled secret.
 *
 * Every secret below is made up and has no known token shape, so only a rule
 * that reads what stands in front of it can find it.
 *
 * @module utils/secret-forms.test
 */

import { maskSecretForms } from './secret-forms.js';
import { StreamingSecretRedactor, isSecretAssignmentName, redactSecretsWithCount } from './secret-redactor.js';

/** A generated-looking value, and the same without capitals. */
const VALUES = ['plainfake' + 'Qz7'.repeat(8), 'plainfake' + 'qz7'.repeat(8)];
/** The second half of a value with spaces or symbols. */
const WORD = 'horse' + 'staple9x';
/** A backslash. */
const B = '\\';
/** A quote escaped `n` backslashes deep. */
const q = (n = 1, c = '"'): string => B.repeat(n) + c;

/** Each written form, as a function of the secret. */
const FORMS: Record<string, (s: string) => string> = {
	envPlain: (s) => `API_KEY=${s}`,
	envDoubleQuoted: (s) => `API_KEY="${s}"`,
	envSingleQuoted: (s) => `API_KEY='${s}'`,
	envEscaped: (s) => `API_KEY=${q()}${s}${q()}`,
	envEscapedThrice: (s) => `DB_PASSWORD=${q(3)}${s}${q(3)}`,
	envEscapedSingle: (s) => `API_KEY=${q(1, "'")}${s}${q(1, "'")}`,
	exportEscaped: (s) => `export SERVICE_TOKEN=${q()}${s}${q()}`,
	envDoubledQuotes: (s) => `API_KEY=""${s}""`,
	envSpacedValue: () => `DB_PASSWORD="correct ${WORD} battery"`,
	envSpacesAround: (s) => `API_KEY = "${s}"`,
	envBacktick: (s) => `API_KEY=\`${s}\``,
	envSymbols: () => `PASSWORD=ab1&${WORD}`,
	envSymbolsComma: () => `DB_PASSWORD=ab1,${WORD};`,
	backslashAssigned: (s) => `DB_PASSWORD=ab${B}${s} ok`,
	backslashLowerName: (s) => `api_key=ab12${B}${s} ok`,
	backslashYaml: (s) => `password: ab12cd${B}${s}`,
	backslashFlag: (s) => `tool --password ab12cd${B}${s} x`,
	backslashHeader: (s) => `x-api-key: ab12cd${B}${s}`,
	backslashChinese: (s) => `密码：ab12${B}${s}`,
	backslashSshpass: (s) => `sshpass -p ab12cd${B}${s} ssh root@203.0.113.9`,
	backslashMysql: (s) => `mysql -u admin -pab12cd${B}${s}`,
	backslashCurl: (s) => `curl -u admin:ab12cd${B}${s} https://api.example.com`,
	backslashScheme: (s) => `sent header Bearer ab12cd${B}${s} to the API`,
	backslashProse: (s) => `the password is ab12cd${B}${s}`,
	backslashQuoted: (s) => `DB_PASSWORD="ab${B}${s}" ok`,
	jsonPair: (s) => `{"API_KEY": "${s}"}`,
	jsonPairEscaped: (s) => `{${q()}API_KEY${q()}: ${q()}${s}${q()}}`,
	jsonPairEscapedThrice: (s) => `{${q(3)}client_secret${q(3)}:${q(3)}${s}${q(3)}}`,
	camelKey: (s) => `"apiKey": "${s}"`,
	camelToken: (s) => `authToken: '${s}'`,
	refreshToken: (s) => `"refresh_token":"${s}"`,
	nestedJson: (s) => `{"body":"{${q()}password${q()}:${q()}${s}${q()}}"}`,
	yamlPassword: (s) => `password: ${s}`,
	yamlSecret: (s) => `client_secret: ${s}`,
	arrow: (s) => `'api_key' => '${s}'`,
	tabs: (s) => `API_KEY\t=\t${s}`,
	carriageReturn: (s) => `client_secret: ${s}\r`,
	fullWidthColon: (s) => `API_KEY：${s}`,
	nextLine: (s) => `API_KEY:\n  ${s}`,
	passLabel: (s) => `pass: ${s}`,
	bearer: (s) => `Authorization: Bearer ${s}`,
	bearerEscaped: (s) => `-H ${q()}Authorization: Bearer ${s}${q()}`,
	basic: (s) => `Authorization: Basic ${s}`,
	bareBearer: (s) => `sent header Bearer ${s} to the API`,
	apiKeyHeader: (s) => `x-api-key: ${s}`,
	cookie: (s) => `Cookie: session=${s}`,
	queryToken: (s) => `https://example.com/cb?access_token=${s}&x=1`,
	queryKey: (s) => `https://x.test/v1?key=${s}`,
	flagSpace: (s) => `tool login --token ${s}`,
	flagEquals: (s) => `tool --api-key=${s}`,
	flagPassword: (s) => `mysql --password ${s}`,
	curlUser: (s) => `curl -u admin:${s} https://api.example.com`,
	sshpass: (s) => `sshpass -p ${s} ssh root@203.0.113.9`,
	sshpassQuotedSpace: (s) => `sshpass -p 'ab ${s} cd' ssh root@203.0.113.9`,
	mysqlAttached: (s) => `mysql -u admin -h db.example.com -p${s}`,
	urlLogin: (s) => `postgres://app:${s}@db.example.com:5432/x`,
	mongoLogin: (s) => `mongodb+srv://app:${s}@c0.example.net/x`,
	atInPassword: (s) => `postgres://app:ab@${s}@db.example.com/x`,
	atThenSpace: (s) => `postgres://app:ab@x.zz ${s}@db.example.com/x`,
	atThenAngle: (s) => `postgres://app:ab@x.zz<${s}@db.example.com/x`,
	tokenAsUser: (s) => `https://${s}:x-oauth-basic@github.com/a/b.git`,
	netrc: (s) => `machine x login y password ${s}`,
	npmrc: (s) => `//registry.npmjs.org/:_authToken=${s}`,
	spacedName: (s) => `api key: ${s}`,
	spacedIs: (s) => `the secret key is ${s}`,
	proseIs: (s) => `the password is ${s}`,
	fullWidthWord: (s) => `password：${s}`,
	markdownTable: (s) => `| API_KEY | ${s} |`,
	markdownBold: (s) => `**API_KEY**: ${s}`,
	markdownCode: (s) => `\`API_KEY\`: \`${s}\``,
	functionCall: (s) => `setToken("${s}")`,
	keywordArgument: (s) => `client(api_key="${s}")`,
	xml: (s) => `<password>${s}</password>`,
	chineseColon: (s) => `密码: ${s}`,
	chineseFullWidth: (s) => `密码：${s}`,
	chineseIs: (s) => `数据库密码是 ${s}`,
	chineseNoGap: (s) => `密码${s}`,
	chineseOtherWord: (s) => `口令=${s}`,
	chineseKey: (s) => `密钥：\`${s}\``,
	chineseTable: (s) => `| 密码 | ${s} |`,
	multiLineNote: (s) => `steps:\n1. set\n   SLACK_SIGNING_SECRET=${q()}${s}${q()}\n2. restart`,
};

/** Ordinary text and code that must come through unchanged. */
const ORDINARY: readonly string[] = [
	'TOKEN_COUNT=5',
	'tokens: 12000 per run',
	'the token expired and the secret scan held the file',
	'password reset flow is broken',
	'API_KEY=$OPENAI_API_KEY',
	'reason: secret_scan',
	'see src/auth/token.service.ts:42',
	'session: crewly-product-team-quinn-47ce967d',
	'commit 8b5b1c603ed8415b80662af37589e350227a8a9c',
	'move DOFXsxtEo-0tiwAx and id got:11111111-2222-3333-4444-555555555555',
	'https://example.com/docs?page=2&sort=name',
	'npm view http://localhost:4873/@types/node',
	'git@github.com:stevehuang0115/crewly.git and ssh://git@github.com/a/b',
	'mysql -u root -p crewly_db',
	'docker run -u 1000:1000 node:20',
	'integrity sha512-Qk9mZ2xpbmVIYXNoVmFsdWUxMjM0NTY3ODkwQWJDZEVm',
	'const token: string = await this.getAuthTokenForSession(sessionName);',
	'const signingValue = process.env.SLACK_SIGNING_SECRET;',
	'{ token: this.deps.tokenStore.current, apiKey: settings.providers.gemini.apiKey }',
	'headers: { Authorization: `Bearer ${accessToken}` }',
	"type Kind = { token: 'token' }",
	'export TOKEN=$(cat ~/.tokenfile)',
	'run it with --token <your-token> and --password "$PW"',
	'date -u +%Y-%m-%dT%H:%M:%SZ',
	'Pass `?token=` on the deep link only, never in `?code=` (see the docs).',
	'AUTH_TOKEN: \'CREWLY_AUTH_TOKEN\',',
	'"jsonwebtoken": "^9.0.2",',
	"'claude-code:api_key': 'Anthropic API key',",
	"type={hidden ? 'password' : 'text'}",
	'hasToken: !!this.config?.botToken,',
	"const cookie = typeof headers.cookie === 'string' ? headers.cookie : undefined)[API_SECURITY_CONSTANTS.TOKEN_COOKIE];",
	'-H "X-Agent-Authorization: b64:$(printf \'%s\' "$AUTH" | base64)"',
	'Second pass: parent-item-membership (so children follow)',
	'docker exec -u root:wheel box true',
];

describe('maskSecretForms', () => {
	for (const [name, form] of Object.entries(FORMS)) {
		it(`masks the ${name} form`, () => {
			for (const value of VALUES) {
				const { text, count } = redactSecretsWithCount(form(value));
				expect(count).toBeGreaterThan(0);
				expect(text).not.toContain(value);
				expect(text).not.toContain(WORD);
				expect(redactSecretsWithCount(text)).toEqual({ text, count: 0 });
			}
		});
	}

	it('leaves ordinary text and code as it is', () => {
		const altered = ORDINARY.filter((line) => redactSecretsWithCount(line).text !== line);
		expect(altered).toEqual([]);
		expect(ORDINARY.length).toBeGreaterThan(20);
	});

	it('keeps serialized JSON valid and everything beside the value', () => {
		const line = JSON.stringify({ cmd: `login --password ${VALUES[0]}`, body: JSON.stringify({ password: `two ${WORD}`, user: 'ann' }), note: 'kept' });
		const parsed = JSON.parse(redactSecretsWithCount(line).text) as { cmd: string; body: string; note: string };
		expect(parsed.note).toBe('kept');
		expect(parsed.cmd).toBe('login --password [REDACTED]');
		expect(JSON.parse(parsed.body)).toEqual({ password: '[REDACTED]', user: 'ann' });
	});

	it('keeps the account and host of a URL login readable, but not a host that may be part of the password', () => {
		expect(maskSecretForms(`redis://app:${VALUES[0]}@cache.example.com:6379`, isSecretAssignmentName).text).toBe('redis://app:[REDACTED]@cache.example.com:6379');
		expect(maskSecretForms(`redis://app:ab@${VALUES[0]}@cache.example.com`, isSecretAssignmentName).text).toBe('redis://app:[REDACTED]@cache.example.com');
	});

	it('asks the caller which names are env secrets', () => {
		expect(maskSecretForms('MY_VALUE=abc', () => false).count).toBe(0);
		expect(maskSecretForms('MY_VALUE=abc', (n) => n === 'MY_VALUE').text).toBe('MY_VALUE=[REDACTED]');
	});
});

describe('long runs that almost match a rule', () => {
	const seeds = ['a-', 'a.', '--a-', 'a://', 'http://a:', 'curl ', 'mysql ', 'secret_', '<password', 'token=', '| a ', '密码'];

	it('are scanned in time that grows with their length', () => {
		const started = Date.now();
		for (const seed of seeds) redactSecretsWithCount(seed.repeat(Math.ceil(80_000 / seed.length)));
		// Without the length limits the first of these alone takes seconds.
		expect(Date.now() - started).toBeLessThan(4_000);
	});
});

describe('labelled secrets split across stream chunks', () => {
	const split = ['flagSpace', 'basic', 'bareBearer', 'apiKeyHeader', 'envSpacedValue', 'sshpass', 'yamlPassword', 'chineseIs', 'curlUser', 'nextLine'];

	it.each(split)('masks the %s form at every chunk size', (name) => {
		const text = `before\n${FORMS[name](VALUES[0])}\nafter\n`;
		for (const size of [1, 2, 3, 7, 16, 1000]) {
			const redactor = new StreamingSecretRedactor();
			let out = '';
			for (let i = 0; i < text.length; i += size) out += redactor.push(text.slice(i, i + size));
			out += redactor.flush();
			expect(out).not.toContain(VALUES[0]);
			expect(out).not.toContain(WORD);
			expect(out.startsWith('before\n')).toBe(true);
			expect(out.endsWith('\nafter\n')).toBe(true);
		}
	});
});

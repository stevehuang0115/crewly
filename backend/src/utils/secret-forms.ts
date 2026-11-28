/**
 * Written forms of a labelled secret, for the secret redactor.
 *
 * The redactor knows env assignments and raw token shapes. This module covers
 * a secret that is recognised by what stands in front of it: a `name: value`
 * pair (JSON, YAML, object literals, also escaped inside another string), a
 * quoted value with spaces, HTTP credential headers, command-line password
 * flags, a login in a URL, a table cell, an XML element, a function argument,
 * a secret word in prose, and the usual Chinese labels.
 *
 * The same text goes through here whether it is a terminal log, a document or
 * program source, so ordinary words and code stay as they are: an unquoted
 * value has to look generated, and an expression (a variable, a member access,
 * a call) is not a stored secret. There is deliberately no "long random
 * string" rule: logs are full of hashes and ids. Every part of a rule that can
 * run on is length-limited: this runs synchronously on terminal output.
 *
 * Masking is idempotent: a masked value is never counted again.
 *
 * @module utils/secret-forms
 */

/** What a rule writes in place of a value. */
const MASK = '[REDACTED]';

/** Name endings that make a `name: value` pair secret, in any spelling. */
const SECRET_NAME_END_RE =
	/(?:api[_-]?key|access[_-]?key|secret|token|passwd|password|pwd|private[_-]?key|signing[_-]?key|credentials?|cookie|authorization)$/i;

/** Short names that mean "password" only when they are the whole name. */
const SHORT_PASSWORD_NAME_RE = /^(?:pass|pw)$/i;

/**
 * `name`, then `=`, `:`, `=>` or `:=`. The quotes around either side may be
 * escaped any number of times, and the value may sit on the next line.
 */
const PAIR_RE =
	/(?<![A-Za-z0-9_.-])((?:--)?[A-Za-z_][A-Za-z0-9_.-]*)((?:\\*["'`])?[ \t]*(?:=>|:=|=|:|：)[ \t]*(?:\r?\n[ \t]+)?)/g;

/** A quoted value's opening quote(s), possibly escaped. */
const OPENING_QUOTE_RE = /^(?:\\*["'`])+/;

/**
 * An unquoted value right after `NAME=`: symbols belong to it; a space, a quote
 * or the next `&name=` ends it. A backslash is part of it unless it escapes a quote.
 */
const BARE_ASSIGNED_RE = /^(?:\[REDACTED[^\]\n]*\]|(?:(?!&[A-Za-z_]+=)(?!\\+["'`])[^\s"'`])*)/;

/** An unquoted value anywhere else: punctuation ends it. Backslashes as above. */
const BARE_VALUE_RE = /^(?:\[REDACTED[^\]\n]*\]|(?:(?!\\+["'`])[^\s"'`;&|,{}()<>])*)/;

/** Punctuation that closes a sentence or a structure, not part of an unquoted value. */
const TRAILING_PUNCTUATION_RE = /(?<!\])[;,.)}\]|]+$/;

/** A variable, a type or a member access: letters only, so nothing generated. */
const EXPRESSION_RE = /^[A-Za-z_$][A-Za-z_$.?![\]]*$/;

/** A dotted path whose parts are identifiers (`config.oauth2.clientSecret`). */
const MEMBER_ACCESS_RE = /^[A-Za-z_$][\w$]*(?:(?:\?\.|!\.|\.)[A-Za-z_$][\w$]*)+[?!]?$/;

/** A name that holds a password, which may be a plain word or a phrase. */
const PASSWORD_NAME_RE = /(?:passwd|password|pwd)$/i;

/** The name of an environment variable, e.g. a constant's value `'CREWLY_API_TOKEN'`. */
const ENV_NAME_VALUE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** A package version or range (`"jsonwebtoken": "^9.0.2"`). */
const VERSION_VALUE_RE = /^[~^<>=v]{0,3}\d+(?:\.(?:\d+|x|\*)){1,3}(?:[-+][\w.-]*)?$/;

/** What no stored secret starts with in quotes: the quote closed something else. */
const NOT_A_QUOTED_VALUE_RE = /^[\s),.;:\]}|?&]|%[sd]/;

/** How an unquoted expression in program source starts. */
const CODE_START_RE = /^[!&*([{/<+-]/;

/** HTTP headers that carry a credential. */
const HEADER_RE =
	/\b(authorization|set-cookie|cookie|x-api-key|x-auth-token)((?:\\*["'`])?[ \t]*:[ \t]*(?:\\*["'`])*(?:(?:Bearer|Basic|Token|ApiKey)[ \t]+)?)((?:(?!\\+["'`])(?!\\+[rn](?:\\|[A-Za-z-]+:))[^\r\n"'`])+)/gi;

/** `Basic xxx` / `Bearer xxx` on their own. */
const SCHEME_RE =
	/\b(Bearer|Basic)([ \t]+)((?:[A-Za-z0-9._~+/=-]|\\(?!\\*["'`rn])){12,})/g;

/** `--password x`, `--client-secret=x`. */
const FLAG_RE =
	/(--(?:[a-z0-9]{1,30}-){0,6}(?:token|password|passwd|secret|api-key|apikey|client-secret))(=|[ \t]+)((?:\\*["'`])*)((?:(?!\\+["'`])[^\s"'`;&|])+)/gi;

/** `sshpass -p x`; a quoted password may hold spaces. */
const SSHPASS_RE =
	/(\bsshpass[ \t]+-p[ \t]*)(?:(\\*["'])((?:(?!\\*["'])[^\n])+)|((?:(?!\\+["'])[^\s"'])+))/g;

/** `mysql -px`: the password is attached to the flag (`-p dbname` is a database name). */
const DATABASE_FLAG_RE =
	/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]{0,300}?[ \t]-p)(?:(\\*["'])((?:(?!\\*["'])[^\n])+)|((?!-)(?:(?!\\+["'])[^\s"'])+))/g;

/** `curl -u user:x` (also wget); `-u` means other things to other commands, e.g. `date -u`. */
const USER_PASSWORD_RE =
	/(\b(?:curl|wget)\b(?:[^\n]|\\\r?\n){0,600}?[ \t](?:-u|--user)[ \t]+\\*["']?[^\s"':\\+$]+:)((?!\/\/)(?:(?!\\+["'])[^\s"']){4,})/g;

/** A key or signature in a URL query. */
const URL_KEY_RE = /([?&](?:key|sig|signature|auth|code)=)([^&\s"'\\]{12,})/gi;

/** Chat webhook URLs, whose path is the credential. */
const WEBHOOK_RE = /(hooks\.slack\.com\/(?:services|triggers)\/|discord(?:app)?\.com\/api\/webhooks\/)([A-Za-z0-9_/-]{20,})/g;

/** A secret word followed by something generated: prose, netrc, bold or code markup. */
const LABELLED_WORD_RE =
	/\b(passwords?|passwd|passcode|(?:api|secret|access|private|signing|auth|client)[ _-]?(?:key|token|secret)|secret|token)((?:\*\*|__|`)?(?:[ \t]+(?:(?:is|was)\b)?|[ \t]*(?:=|:|：))[ \t]*(?:\*\*|__|`|\\*["'])*[ \t]*)((?:(?!\\+["'`])[^\s"'`<>|*]){8,})/gi;

/** `| name | value |`. */
const TABLE_CELL_RE = /(\|[ \t*`]*)([A-Za-z_][A-Za-z0-9_-]*)([ \t*`]*\|[ \t*`]*)([^\s|`*]+)/g;

/** `<password>value</password>`. */
const XML_ELEMENT_RE = /<([A-Za-z_-]{0,60}(?:password|secret|token|apikey|api_key)[A-Za-z_-]{0,60})>([^<\n]+)(?=<\/)/gi;

/** `setToken("value")`, `api_key("value")`. */
const CALL_ARGUMENT_RE = /\b([A-Za-z_]{0,60}(?:password|secret|token|apikey|api_key)[A-Za-z_]{0,60})(\([ \t]*\\*["'`])([^"'`\\\n]{8,})/gi;

/** Chinese labels for a password or key, with or without a separator. */
const CHINESE_LABEL_RE =
	/(密码|口令|密钥|秘钥|令牌|授权码)([ \t]*(?:是|为|＝|=|:|：|\|)?[ \t]*(?:\r?\n[ \t]*)?(?:\*\*|__|`|\\*["'“‘「])*[ \t]*)((?:[A-Za-z0-9!@#$%^&*()_+=./?~{}[\];,<>-]|\\(?!\\*["'`rn])){4,})/g;

/** `scheme://userinfo@host`. The userinfo runs to the last `@`, so a password may hold one. */
const URL_LOGIN_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,40}):\/\/([^\s"'`<>\\]{0,512})@(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._-]+)/g;

/** A running count of what was masked. */
interface Tally {
	/** Values masked so far */
	count: number;
}

/** Text with its labelled secrets masked. */
export interface SecretFormsResult {
	/** The masked text */
	text: string;
	/** Number of values masked */
	count: number;
}

/**
 * Whether a value is a stand-in: empty, a variable reference, already masked,
 * a `<placeholder>` or a literal like `null`.
 *
 * @param value - Candidate value
 * @returns True when there is nothing to hide
 */
function isPlaceholder(value: string): boolean {
	return !value.trim() || /^(?:\$|\[REDACTED|<|\{\{|process\.env|(?:true|false|null|undefined|none|string|number)$)/i.test(value.trim());
}

/**
 * Whether an unquoted word looks like a credential and not like prose or code.
 *
 * @param value - Unquoted value
 * @returns True for six or more characters with a digit, or twenty or more that are not an expression
 */
function looksGenerated(value: string): boolean {
	if (value.length < 6 || EXPRESSION_RE.test(value) || MEMBER_ACCESS_RE.test(value)) return false;
	return /\d/.test(value) || value.length >= 20;
}

/**
 * Whether a value mixes letters and digits.
 *
 * @param value - Candidate value
 * @returns True when it holds both
 */
function isMixed(value: string): boolean {
	return /[A-Za-z]/.test(value) && /\d/.test(value);
}

/**
 * Whether a URL's user part is an account name that can stay readable.
 *
 * @param user - Text before the colon
 * @returns True for a short, name-like user
 */
function isAccountName(user: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(user) && !(user.length >= 12 && isMixed(user));
}

/**
 * Masks the password or token of a login written into a URL, keeping the user
 * and host. When another `@` follows, the apparent host may be part of the
 * password, so the mask runs to the last one.
 *
 * @param text - Text to mask
 * @param tally - Running count
 * @returns The masked text
 */
function maskUrlLogins(text: string, tally: Tally): string {
	let done = '';
	let copied = 0;
	let skipUntil = 0;
	for (const found of text.matchAll(URL_LOGIN_RE)) {
		const at = found.index ?? 0;
		if (at < skipUntil) continue;
		const [whole, scheme, info, host] = found;
		// "host:8080/@scope" is a port and a path, not a login.
		if (/^[^/?#]*:\d+\//.test(info)) continue;
		const pair = /^([^/?#:]*):(.*)$/.exec(info);
		let user = pair ? pair[1] : '';
		let secret = pair ? pair[2] : info;
		// A lone userinfo is a token only when it looks like one (`ssh://git@host` is not).
		if (!pair && !(!/[/?#]/.test(info) && info.length >= 12 && isMixed(info))) continue;
		if (pair && secret === 'x-oauth-basic') [secret, user] = [user, ''];
		if (isPlaceholder(secret)) continue;
		const kept = user && isAccountName(user) ? `${user}:` : '';
		const end = at + whole.length;
		const lineEnd = text.indexOf('\n', end);
		const tail = text.slice(end, lineEnd < 0 ? text.length : lineEnd).split('://')[0];
		const unsure = Boolean(pair) && tail.includes('@');
		const upTo = unsure ? end + tail.lastIndexOf('@') + 1 : end;
		done += `${text.slice(copied, at)}${scheme}://${kept}${MASK}@${unsure ? '' : host}`;
		copied = upTo;
		skipUntil = upTo;
		tally.count += 1;
	}
	return done + text.slice(copied);
}

/**
 * Whether a quoted value is something other than a secret: markup or
 * punctuation after a closing quote, a format string, a variable's name, a
 * version, the field's own name, or, for anything but a password, plain words
 * (a label, a type, a constant).
 *
 * @param value - Text between the quotes
 * @param name - Name of the pair
 * @returns True when it should stay readable
 */
function isOrdinaryQuotedValue(value: string, name: string): boolean {
	if (value.length < 4 || value.toLowerCase() === name.toLowerCase()) return true;
	if (NOT_A_QUOTED_VALUE_RE.test(value) || ENV_NAME_VALUE_RE.test(value) || VERSION_VALUE_RE.test(value)) return true;
	return !/\d/.test(value) && !PASSWORD_NAME_RE.test(name);
}

/**
 * Masks the value of every secret-named pair.
 *
 * A quoted value is masked whole, spaces included, up to its closing quote. An
 * unquoted one has to look generated, except right after `NAME=` for a name
 * the redactor already treats as secret.
 *
 * @param text - Text to mask
 * @param isEnvSecretName - The redactor's env-name test
 * @param tally - Running count
 * @returns The masked text
 */
function maskPairs(text: string, isEnvSecretName: (name: string) => boolean, tally: Tally): string {
	const pattern = new RegExp(PAIR_RE.source, 'g');
	let done = '';
	let from = 0;
	let found: RegExpExecArray | null;
	while ((found = pattern.exec(text))) {
		const [whole, rawName, separator] = found;
		const name = rawName.replace(/^-+/, '');
		const envName = isEnvSecretName(name);
		if (!envName && !SECRET_NAME_END_RE.test(name) && !SHORT_PASSWORD_NAME_RE.test(name)) {
			// Resume just after the name so a pair inside this value is still seen.
			pattern.lastIndex = found.index + rawName.length;
			continue;
		}
		let start = found.index + whole.length;
		const newline = text.indexOf('\n', start);
		const lineEnd = newline < 0 ? text.length : newline;
		const rest = text.slice(start, lineEnd);
		const opening = OPENING_QUOTE_RE.exec(rest);
		const assigned = envName && separator === '=';
		let end: number;
		if (opening) {
			start += opening[0].length;
			const close = text.indexOf(opening[0].slice(-1), start);
			end = close >= 0 && close < lineEnd ? close : lineEnd;
			while (end > start && text[end - 1] === '\\') end -= 1;
		} else {
			const bare = (assigned ? BARE_ASSIGNED_RE : BARE_VALUE_RE).exec(rest)?.[0] ?? '';
			end = start + bare.replace(TRAILING_PUNCTUATION_RE, '').length;
		}
		const value = text.slice(start, end);
		if (isPlaceholder(value) || value.includes('${')) continue;
		// "pass:" also ends ordinary sentences ("second pass: ..."), so its bare value needs a digit.
		if (!opening && !assigned && SHORT_PASSWORD_NAME_RE.test(name) && !/\d/.test(value)) continue;
		// `ok ? 'password' : 'text'` is a choice between two strings, not a pair.
		if (/^\\*["'`]/.test(separator) && /\?[ \t]*["'`]$/.test(text.slice(Math.max(0, found.index - 4), found.index))) continue;
		if (opening && isOrdinaryQuotedValue(value, name)) continue;
		if (!opening && !assigned && (text[end] === '(' || CODE_START_RE.test(value) || !looksGenerated(value))) continue;
		done += text.slice(from, start) + MASK;
		from = end;
		pattern.lastIndex = end;
		tally.count += 1;
	}
	return done + text.slice(from);
}

/**
 * Masks every secret recognised by what stands in front of it.
 *
 * Run it before the token-shape detectors: it needs the text's original
 * quoting to find where a value ends.
 *
 * @param text - Text to mask
 * @param isEnvSecretName - Whether a name is one the redactor masks in `NAME=value`
 * @returns The masked text and the number of values masked
 *
 * @example
 * ```ts
 * maskSecretForms('{"password": "two words"}', () => false).text; // '{"password": "[REDACTED]"}'
 * ```
 */
export function maskSecretForms(text: string, isEnvSecretName: (name: string) => boolean): SecretFormsResult {
	const tally: Tally = { count: 0 };
	const mask = (whole: string, keep: string, value: string, accept: (v: string) => boolean = looksGenerated): string => {
		if (isPlaceholder(value) || !accept(value.trim())) return whole;
		tally.count += 1;
		return keep + MASK;
	};
	const always = (): boolean => true;

	let out = maskUrlLogins(text, tally);
	for (const rule of [SSHPASS_RE, DATABASE_FLAG_RE]) {
		out = out.replace(rule, (w: string, keep: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) =>
			mask(w, keep + (quote ?? ''), quoted ?? bare ?? '', always),
		);
	}
	out = out.replace(CHINESE_LABEL_RE, (w: string, label: string, gap: string, value: string) => mask(w, label + gap, value, always));
	out = out.replace(HEADER_RE, (w: string, name: string, middle: string, value: string) =>
		// The credential is the first word; prose and code after a header name are not one.
		mask(w, name + middle, value, (v) => !CODE_START_RE.test(v) && !/\$[({]/.test(v) && looksGenerated(v.split(/[\s;,()[\]]/)[0])),
	);
	out = out.replace(SCHEME_RE, (w: string, scheme: string, gap: string, value: string) => mask(w, scheme + gap, value, (v) => /\d/.test(v)));
	out = out.replace(FLAG_RE, (w: string, flag: string, gap: string, quotes: string, value: string) => mask(w, flag + gap + quotes, value));
	out = out.replace(URL_KEY_RE, (w: string, keep: string, value: string) => mask(w, keep, value, isMixed));
	out = out.replace(WEBHOOK_RE, (w: string, keep: string, value: string) => mask(w, keep, value, always));
	// "-u 1000:1000" is a user and group id.
	out = out.replace(USER_PASSWORD_RE, (w: string, keep: string, value: string) => mask(w, keep, value, (v) => !/^\d+$/.test(v)));
	out = out.replace(CALL_ARGUMENT_RE, (w: string, name: string, open: string, value: string) =>
		mask(w, name + open, value, (v) => isMixed(v) && !v.includes(' ')),
	);
	out = out.replace(XML_ELEMENT_RE, (w: string, name: string, value: string) => mask(w, `<${name}>`, value, always));
	out = out.replace(TABLE_CELL_RE, (w: string, open: string, name: string, middle: string, value: string) =>
		SECRET_NAME_END_RE.test(name) || isEnvSecretName(name) ? mask(w, open + name + middle, value) : w,
	);
	out = maskPairs(out, isEnvSecretName, tally);
	out = out.replace(LABELLED_WORD_RE, (w: string, word: string, gap: string, value: string) =>
		mask(w, word + gap, value, (v) => isMixed(v) && !MEMBER_ACCESS_RE.test(v) && !v.includes('(')),
	);

	return { text: out, count: tally.count };
}

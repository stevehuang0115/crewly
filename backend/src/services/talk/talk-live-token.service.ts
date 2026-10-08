/**
 * Drive mode voice: Gemini Live ephemeral tokens (specs/2026-10-08-drive-mode.md §3).
 *
 * The phone talks to Gemini Live directly (realtime audio, barge-in), but it
 * must never see this machine's Gemini API key. So the machine mints a
 * short-lived token (`POST /v1alpha/auth_tokens`) that:
 *
 *  - opens ONE session within a minute and lasts at most 30 minutes;
 *  - is locked to the briefer's setup — model, audio output, voice, the
 *    system instruction and the briefing tools — so a page holding it cannot
 *    turn it into a general-purpose Gemini session.
 *
 * The key comes from the Antigravity credential Crewly already stores
 * (`harness-credentials.json`), else `GEMINI_API_KEY`. Neither the key nor
 * the token is ever logged.
 *
 * @module services/talk/talk-live-token.service
 */

import { TALK_LIVE_CONSTANTS } from '../../constants.js';
import { getHarnessCredentialsStore } from '../harness/harness-credentials.store.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

const C = TALK_LIVE_CONSTANTS;

/** A language the briefer starts in. */
export type LiveLanguage = (typeof TALK_LIVE_CONSTANTS.LANGUAGES)[number];

/** A Gemini function declaration (OpenAPI-subset schema). */
export interface LiveFunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: 'OBJECT';
    properties: Record<string, { type: 'STRING' | 'BOOLEAN'; description: string }>;
    required?: string[];
  };
}

/** The Live session setup the token is locked to (BidiGenerateContentSetup). */
export interface LiveSetup {
  model: string;
  generationConfig: {
    responseModalities: ['AUDIO'];
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
  };
  systemInstruction: { parts: Array<{ text: string }> };
  tools: Array<{ functionDeclarations: LiveFunctionDeclaration[] }>;
  inputAudioTranscription: Record<string, never>;
  outputAudioTranscription: Record<string, never>;
}

/** What the page gets. */
export interface LiveTokenResult {
  /** `auth_tokens/…` — pass as `access_token` */
  token: string;
  /** The Live WebSocket URL with the token in it */
  wsUrl: string;
  model: string;
  apiVersion: string;
  /** The setup to send as the first message (the token enforces it anyway) */
  setup: LiveSetup;
  /** ISO: the session must start before this */
  newSessionExpireTime: string;
  /** ISO: the token stops working */
  expireTime: string;
  language: LiveLanguage;
}

/** A token failure with an HTTP status and code. */
export class TalkLiveTokenError extends Error {
  /**
   * @param status - HTTP status
   * @param code - One of {@link TALK_LIVE_CONSTANTS.CODES}
   * @param message - Owner-readable message
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TalkLiveTokenError';
  }
}

/** Collaborators (tests). */
export interface TalkLiveTokenDeps {
  /** The machine's Gemini API key, or null */
  getApiKey?: () => string | null;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logger?: ComponentLogger;
}

/**
 * The briefing tools the voice model may call. The page carries each call to
 * this machine's `/api/briefing` over the relay.
 *
 * @returns Function declarations
 */
export function briefingToolDeclarations(): LiveFunctionDeclaration[] {
  const itemId = { type: 'STRING' as const, description: 'The item id from get_next_item.' };
  return [
    {
      name: 'get_next_item',
      description:
        'Get the next thing waiting on the owner (most urgent first) with its details and answer options. Call it when the session starts, after each item is settled, and whenever the owner asks what is next. Returns empty:true when nothing is waiting.',
    },
    {
      name: 'answer_item',
      description:
        "Give the owner's answer to an item: an option_key from its options, and/or their words as text. For finished work (review) use option_key accept, or send_back with text saying what to fix. If it returns needs_confirmation, read confirmQuestion to the owner and only after a clear yes call again with the same answer, confirm=true and the confirm_token.",
      parameters: {
        type: 'OBJECT',
        properties: {
          item_id: itemId,
          option_key: { type: 'STRING', description: 'Key of the chosen option (e.g. a, b, accept, send_back).' },
          text: { type: 'STRING', description: "The owner's own words, in their language, as said (no paraphrase)." },
          confirm: { type: 'BOOLEAN', description: 'true only on the second call, after the owner confirmed out loud.' },
          confirm_token: { type: 'STRING', description: 'The token from the needs_confirmation result.' },
        },
        required: ['item_id'],
      },
    },
    {
      name: 'skip_item',
      description:
        'The owner says next / skip / not now: hide the item for a few hours without answering. With dismiss=true it is dropped for good ("I don\'t care about this anymore") — only when the owner says so.',
      parameters: {
        type: 'OBJECT',
        properties: { item_id: itemId, dismiss: { type: 'BOOLEAN', description: 'Drop it for good (owner said they do not care).' } },
        required: ['item_id'],
      },
    },
    {
      name: 'later_item',
      description: 'The owner says later / remind me: bring the item back at a time (ISO 8601 with timezone offset), or tomorrow morning when no time is given.',
      parameters: {
        type: 'OBJECT',
        properties: { item_id: itemId, at: { type: 'STRING', description: 'When to bring it back (ISO 8601), optional.' } },
        required: ['item_id'],
      },
    },
    {
      name: 'ask_about_item',
      description:
        "The owner asks something about an item that its details do not answer. The question goes to the agent who is waiting; the item comes back to the queue (with the agent's answer) when they reply. Answer from details yourself whenever you can instead.",
      parameters: {
        type: 'OBJECT',
        properties: { item_id: itemId, question: { type: 'STRING', description: "The owner's question, in their words." } },
        required: ['item_id', 'question'],
      },
    },
  ];
}

/** Spoken name of each starting language. */
const LANGUAGE_NAMES: Record<LiveLanguage, string> = { zh: 'Mandarin Chinese', en: 'English', es: 'Spanish' };

/**
 * The briefer's system instruction.
 *
 * @param language - Language to start in
 * @returns Instruction text
 */
export function briefingSystemInstruction(language: LiveLanguage): string {
  return [
    "You are Crewly's voice briefer. The owner is listening on a phone, often while driving: they cannot look at the screen.",
    `Speak ${LANGUAGE_NAMES[language]} to start; if the owner speaks another language, switch to it and stay in it.`,
    'Be brief: one or two short sentences at a time, natural spoken language, no lists, no URLs, no ids unless asked.',
    'Start by calling get_next_item. Read ONE item at a time: who is waiting and the summary, then the options. Then stop and listen.',
    'Never invent facts. Everything you say about an item comes from get_next_item results; if the details do not answer a question, say you will ask, and call ask_about_item.',
    'When the owner answers, call answer_item with their choice (option_key) and/or their own words (text) — never put words in their mouth. If the result is needs_confirmation, ask exactly: confirm? (in their language, e.g. 确认吗？) and call again with confirm=true and the confirm_token only after a clear yes.',
    'next / skip / 下一个 / 跳过 → skip_item, then get_next_item. later / remind me / 晚点 / 明天提醒我 → later_item. drop it / 不管了 → skip_item with dismiss=true.',
    'wait / what does this mean / 等一下 / 这是什么意思 → explain from the details; if they do not cover it, ask_about_item and move on to the next item. continue / 继续 → carry on where you were.',
    'repeat / 再说一遍 → repeat the current item. pause / 暂停 → say one word and stay silent until the owner speaks.',
    "If an item has lookupAnswer, say first that the agent answered the owner's earlier question, and what they said. If it has reminder, say it is the reminder they asked for.",
    'When nothing is waiting, say so in one sentence and stay listening; call get_next_item again if the owner asks.',
    'If a tool fails, say so in one sentence and offer to try again or move on.',
  ].join('\n');
}

/**
 * Field mask over a setup, the way the Gemini SDK builds it
 * (`tokens.create` with `lockAdditionalFields: []`): every top-level field
 * and, for an object, each of its keys.
 *
 * @param setup - The setup
 * @returns Comma-separated field paths
 */
export function setupFieldMask(setup: object): string {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(setup)) {
    if (value && typeof value === 'object' && Object.keys(value).length > 0) {
      fields.push(...Object.keys(value).map((k) => `${key}.${k}`));
    } else {
      fields.push(key);
    }
  }
  return fields.join(',');
}

/**
 * Normalise the requested language.
 *
 * @param raw - Body value
 * @returns A supported language (default Chinese)
 */
export function parseLiveLanguage(raw: unknown): LiveLanguage {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 2) : '';
  return (C.LANGUAGES as readonly string[]).includes(v) ? (v as LiveLanguage) : C.DEFAULT_LANGUAGE;
}

/** Mints Gemini Live ephemeral tokens for Drive mode. */
export class TalkLiveTokenService {
  private readonly logger: ComponentLogger;

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: TalkLiveTokenDeps = {}) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('TalkLiveToken');
  }

  /** @returns The Gemini API key, or null */
  private apiKey(): string | null {
    if (this.deps.getApiKey) return this.deps.getApiKey();
    let stored: string | null = null;
    try {
      stored = getHarnessCredentialsStore().getAntigravityGeminiApiKey();
    } catch {
      stored = null;
    }
    const env = (this.deps.env ?? process.env)[C.API_KEY_ENV];
    return stored || (typeof env === 'string' && env.trim() ? env.trim() : null);
  }

  /** @returns Whether a key is configured (no network) */
  hasKey(): boolean {
    return !!this.apiKey();
  }

  /**
   * The setup for a language.
   *
   * @param language - Starting language
   * @returns Setup
   */
  buildSetup(language: LiveLanguage): LiveSetup {
    const env = this.deps.env ?? process.env;
    const model = (env[C.MODEL_ENV] || C.DEFAULT_MODEL).trim();
    return {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: C.VOICE } } },
      },
      systemInstruction: { parts: [{ text: briefingSystemInstruction(language) }] },
      tools: [{ functionDeclarations: briefingToolDeclarations() }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
  }

  /**
   * Mint one token for one Live session.
   *
   * @param language - Starting language
   * @returns Token, URL and the setup it is locked to
   * @throws TalkLiveTokenError — `no_gemini_key` (409), `google_rejected` / `unreachable` (502)
   */
  async mint(language: LiveLanguage): Promise<LiveTokenResult> {
    const key = this.apiKey();
    if (!key) throw new TalkLiveTokenError(409, C.CODES.NO_KEY, 'Add a Gemini API key in Settings to use Drive mode.');
    const env = this.deps.env ?? process.env;
    const apiVersion = (env[C.API_VERSION_ENV] || C.DEFAULT_API_VERSION).trim();
    const now = (this.deps.now ?? (() => new Date()))();
    const expireTime = new Date(now.getTime() + C.TOKEN_TTL_MS).toISOString();
    const newSessionExpireTime = new Date(now.getTime() + C.NEW_SESSION_WINDOW_MS).toISOString();
    const setup = this.buildSetup(language);
    const body = {
      uses: C.TOKEN_USES,
      expireTime,
      newSessionExpireTime,
      bidiGenerateContentSetup: setup,
      fieldMask: setupFieldMask(setup),
    };
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(`${C.API_BASE}/${apiVersion}/auth_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn('Gemini Live token request failed', { error: error instanceof Error ? error.name : 'unknown' });
      throw new TalkLiveTokenError(502, C.CODES.UNREACHABLE, 'Could not reach Google to start the voice session.');
    }
    let json: { name?: unknown; error?: { status?: unknown } } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      json = {};
    }
    if (!res.ok || typeof json.name !== 'string' || !json.name) {
      // Google's status word only ("PERMISSION_DENIED"): never the body, which may echo the request.
      const status = typeof json.error?.status === 'string' ? json.error.status : String(res.status);
      this.logger.warn('Gemini Live token refused', { httpStatus: res.status, status });
      const hint = res.status === 400 || res.status === 403 ? ' Check that the Gemini API key in Settings is valid and has the Live API enabled.' : '';
      throw new TalkLiveTokenError(502, C.CODES.GOOGLE_REJECTED, `Google refused the voice session (${status}).${hint}`);
    }
    const token = json.name;
    const model = setup.model.replace(/^models\//, '');
    this.logger.info('Gemini Live token minted', { model, apiVersion, language });
    return {
      token,
      wsUrl: `${C.WS_BASE}/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`,
      model,
      apiVersion,
      setup,
      newSessionExpireTime,
      expireTime,
      language,
    };
  }
}

let instance: TalkLiveTokenService | null = null;

/**
 * The process-wide token service.
 *
 * @returns Service
 */
export function getTalkLiveTokenService(): TalkLiveTokenService {
  instance ??= new TalkLiveTokenService();
  return instance;
}

/**
 * Replace the token service (tests).
 *
 * @param service - Service or null (reset)
 */
export function setTalkLiveTokenService(service: TalkLiveTokenService | null): void {
  instance = service;
}

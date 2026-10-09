/**
 * Drive mode voice: Gemini Live ephemeral tokens (specs/2026-10-08-drive-mode.md §3).
 *
 * This is the machine-hosted FALLBACK: the portal starts Drive mode on Crewly
 * Cloud (`POST /api/cloud/talk/session`, Cloud-held key, §7). The setup here
 * is the same voice orchestrator, with the same tools and VAD.
 *
 * The phone talks to Gemini Live directly (realtime audio, barge-in), but it
 * must never see this machine's Gemini API key. So the machine mints a
 * short-lived token (`POST /v1alpha/auth_tokens`) that:
 *
 *  - opens ONE session within a minute and lasts at most 30 minutes;
 *  - is locked to the briefer's setup — model, audio output, voice, the
 *    system instruction, the tools and voice activity detection — so a page holding it cannot
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
  /** Voice activity detection: how easily the owner's voice starts / ends a turn */
  realtimeInputConfig: {
    automaticActivityDetection: { startOfSpeechSensitivity: string; endOfSpeechSensitivity: string; prefixPaddingMs: number; silenceDurationMs: number };
    activityHandling: string;
  };
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
 * The tools the voice orchestrator may call. The page carries each call to
 * Crewly Cloud (`/api/cloud/talk/session/…`); waiting items come from the
 * owner's machine (`/api/briefing`).
 *
 * @returns Function declarations
 */
export function driveToolDeclarations(): LiveFunctionDeclaration[] {
  const itemId = { type: 'STRING' as const, description: 'The item id from get_waiting_item.' };
  const target = { type: 'STRING' as const, description: 'Who: an agent name ("Ella"), a team ("CE team") or a channel ("#daily-info") — or a target id from list_targets.' };
  return [
    {
      name: 'list_targets',
      description: 'Everyone the owner can talk to: agents (with team and machine), teams (answered by their lead) and Crewly channels. Use it when you are not sure who the owner means.',
    },
    {
      name: 'send_to',
      description:
        "Send the owner's words to an agent, a team or a channel, on any of the owner's machines. Returns at once (status sent) — the answer comes later through check_replies or as a message you are given. If it returns ambiguous, ask the owner which one of the candidates and call again with its id. If it returns offline, tell the owner that machine is offline and the message waits.",
      parameters: {
        type: 'OBJECT',
        properties: {
          target,
          text: { type: 'STRING', description: "The owner's own words for them, in the owner's language, as said (no paraphrase)." },
        },
        required: ['target', 'text'],
      },
    },
    {
      name: 'check_replies',
      description: 'New replies from agents since you last checked, and who is still working. Use it when the owner asks "did Ella answer?" or after a while of silence.',
    },
    {
      name: 'recall',
      description: 'What an agent recently sent the owner (their DMs and threads, last few days), best match to a hint first. Use it for "what did Ella send me about X? say it again".',
      parameters: {
        type: 'OBJECT',
        properties: { target, hint: { type: 'STRING', description: 'What it was about, in the owner\'s words (optional).' } },
        required: ['target'],
      },
    },
    {
      name: 'get_waiting_item',
      description: 'Only when the owner asks ("anything waiting for me?", "有什么要我处理的？"): the next decision card or finished work waiting for them. Returns empty:true when nothing is waiting. Never call it on your own.',
    },
    {
      name: 'answer_item',
      description:
        "Answer a waiting item: an option_key from its options, and/or the owner's words as text. For finished work use option_key accept, or send_back with text saying what to fix. If it returns needs_confirmation, read confirmQuestion and only after a clear yes call again with the same answer, confirm=true and the confirm_token.",
      parameters: {
        type: 'OBJECT',
        properties: {
          item_id: itemId,
          option_key: { type: 'STRING', description: 'Key of the chosen option (e.g. a, b, accept, send_back).' },
          text: { type: 'STRING', description: "The owner's own words, as said (no paraphrase)." },
          confirm: { type: 'BOOLEAN', description: 'true only on the second call, after the owner confirmed out loud.' },
          confirm_token: { type: 'STRING', description: 'The token from the needs_confirmation result.' },
        },
        required: ['item_id'],
      },
    },
    {
      name: 'skip_item',
      description: 'The owner says next / skip about a waiting item: it comes back in a few hours.',
      parameters: { type: 'OBJECT', properties: { item_id: itemId }, required: ['item_id'] },
    },
    {
      name: 'later_item',
      description: 'The owner says later / remind me about a waiting item: it comes back at a time (ISO 8601 with offset), or tomorrow morning.',
      parameters: {
        type: 'OBJECT',
        properties: { item_id: itemId, at: { type: 'STRING', description: 'When to bring it back (ISO 8601), optional.' } },
        required: ['item_id'],
      },
    },
    {
      name: 'end_session',
      description: 'The owner says end / 结束 / that is all: every agent posts one recap where its conversation belongs, and the owner gets a summary in Slack. Say goodbye in one sentence after it.',
    },
  ];
}

/** Spoken name of each starting language. */
const LANGUAGE_NAMES: Record<LiveLanguage, string> = { zh: 'Mandarin Chinese', en: 'English', es: 'Spanish' };

/**
 * The voice orchestrator's system instruction.
 *
 * @param language - Language to start in
 * @returns Instruction text
 */
export function driveSystemInstruction(language: LiveLanguage): string {
  return [
    "You are Crewly's voice orchestrator. The owner talks to their agents through you, on a phone, often while driving: they cannot look at the screen.",
    `Speak ${LANGUAGE_NAMES[language]} to start; if the owner speaks another language, switch to it and stay in it.`,
    'Be brief: one or two short sentences, natural spoken language, no lists. Never read URLs, ids, file paths or ticket numbers aloud.',
    'Start with one short greeting and listen. Do not read anything out on your own.',
    'Route the owner\'s words: "tell Ella …", "ask the CE team …", "in #daily-info, …" → send_to with the owner\'s own words (never paraphrase or add your own). If it is unclear who is meant, ask, or call list_targets; if send_to says ambiguous, ask which one.',
    'send_to returns at once: say who has it in a few words ("Sent, Ella is on it.") and keep talking with the owner — they can start another conversation while waiting.',
    'Replies arrive as messages "[reply] <name>: …" between turns, or from check_replies. Relay them faithfully and briefly, saying who it is from; never invent or embellish. If someone is still working, say so when asked.',
    'Follow-ups go to the same person: "tell her …" means the agent of the last reply, unless the owner names someone else.',
    '"what did Ella send me about X? say it again" → recall, then read the best match briefly; the owner can then continue with send_to.',
    'Only when the owner asks ("anything waiting for me?") → get_waiting_item, then answer_item / skip_item / later_item as they say. Sensitive answers return needs_confirmation: ask exactly "confirm?" (in their language, e.g. 确认吗？) and call again with confirm=true and the confirm_token only after a clear yes.',
    'repeat / 再说一遍 → repeat the last thing. pause / 暂停 → say one word and stay silent until the owner speaks.',
    'end / 结束 / that is all → end_session, then one goodbye sentence.',
    'If a tool fails, say so in one sentence and offer to try again.',
  ].join('\n');
}

/**
 * Field mask over a setup, the way the Gemini SDK builds it
 * (`tokens.create` with `lockAdditionalFields: []`): every top-level field
 * and, for an object, each of its keys — except the fields in
 * {@link TALK_LIVE_CONSTANTS.FIELD_MASK_WHOLE}, masked by their top-level key.
 *
 * @param setup - The setup
 * @returns Comma-separated field paths
 */
export function setupFieldMask(setup: object): string {
  const whole = new Set<string>(C.FIELD_MASK_WHOLE);
  const fields: string[] = [];
  for (const [key, value] of Object.entries(setup)) {
    // An array (tools) is masked as a whole: Google rejects `tools.0`
    // ("field_mask is invalid for BidiGenerateContentSetup", 2026-10-08).
    if (!whole.has(key) && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
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
      systemInstruction: { parts: [{ text: driveSystemInstruction(language) }] },
      tools: [{ functionDeclarations: driveToolDeclarations() }],
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: C.VAD.START_OF_SPEECH_SENSITIVITY,
          endOfSpeechSensitivity: C.VAD.END_OF_SPEECH_SENSITIVITY,
          prefixPaddingMs: C.VAD.PREFIX_PADDING_MS,
          silenceDurationMs: C.VAD.SILENCE_DURATION_MS,
        },
        activityHandling: C.VAD.ACTIVITY_HANDLING,
      },
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

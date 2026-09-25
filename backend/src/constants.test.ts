/**
 * Tests for backend/src/constants.ts.
 *
 * `constants.ts` is a large central config file. Rather than asserting on
 * every value (which would just duplicate the source), this test focuses on
 * the constants where wrong values would silently break a flow — most
 * critically the OAuth scope set used to issue new Google credentials.
 */
import {
  API_SECURITY_CONSTANTS,
  BROWSER_PROXY_CONSTANTS,
  CLOUD_SYNC_CONSTANTS,
  GOOGLE_OAUTH_CONSTANTS,
  GOOGLE_WORKSPACE_CONSTANTS,
  LOGIN_REQUIRED_PATTERN_SETS,
  MICROSOFT_TODO_CONSTANTS,
  RUNTIME_COMPACT_COMMANDS,
  RUNTIME_INPUT_READY_PATTERNS,
  RUNTIME_TYPES,
  SLACK_CLOUD_CONSTANTS,
  TRIGGER_ENGINE_CONSTANTS,
  CRON_SCHEDULE_CONSTANTS,
  WHATSAPP_CONSTANTS,
} from './constants.js';

describe('GOOGLE_OAUTH_CONSTANTS', () => {
  describe('DEFAULT_SCOPES', () => {
    const scopes = GOOGLE_OAUTH_CONSTANTS.DEFAULT_SCOPES;

    it('uses gmail.modify as the single Gmail scope so all 9 actions of the agent gmail skill work without re-auth', () => {
      // gmail.modify is a Google-side functional superset that covers
      // gmail.readonly + gmail.send + label/state mutations. Crewly's
      // skill-executor does string-exact scope matching, so declaring
      // gmail.modify alone is what makes the agent gmail skill (which
      // requires gmail.modify) accept credentials minted via this flow.
      const gmailScopes = scopes.filter((s) => s.includes('gmail'));
      expect(gmailScopes).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
    });

    it('does NOT request gmail.readonly or gmail.send separately (gmail.modify covers them)', () => {
      expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.readonly');
      expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.send');
    });

    it('includes openid + email for user identity resolution', () => {
      expect(scopes).toContain('openid');
      expect(scopes).toContain('email');
    });

    it('is non-empty (defaults must be populated)', () => {
      expect(scopes.length).toBeGreaterThan(0);
    });
  });

  describe('endpoint URLs', () => {
    it('points AUTH_BASE_URL at Google production OAuth endpoint', () => {
      expect(GOOGLE_OAUTH_CONSTANTS.AUTH_BASE_URL).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
    });

    it('points TOKEN_ENDPOINT at the Google token endpoint', () => {
      expect(GOOGLE_OAUTH_CONSTANTS.TOKEN_ENDPOINT).toBe(
        'https://oauth2.googleapis.com/token',
      );
    });

    it('points USERINFO_ENDPOINT at the Google userinfo endpoint', () => {
      expect(GOOGLE_OAUTH_CONSTANTS.USERINFO_ENDPOINT).toBe(
        'https://www.googleapis.com/oauth2/v2/userinfo',
      );
    });
  });

  describe('WORKSPACE_SCOPES', () => {
    it('exposes a broader workspace set for skills that need Drive/Calendar/Docs', () => {
      // This is intentionally separate from DEFAULT_SCOPES — skills that
      // need broader access can request these via the explicit override
      // path on /credentials/oauth/google/start.
      const ws = GOOGLE_OAUTH_CONSTANTS.WORKSPACE_SCOPES;
      expect(Array.isArray(ws)).toBe(true);
      expect(ws.length).toBeGreaterThan(0);
    });
  });
});

describe('BROWSER_PROXY_CONSTANTS', () => {
  it('SWEEP_INTERVAL_MS is 60s — wall-clock cadence the relay-side stale watcher runs on', () => {
    expect(BROWSER_PROXY_CONSTANTS.SWEEP_INTERVAL_MS).toBe(60_000);
  });

  it('STALE_PURGE_THRESHOLD_MS is 5 minutes — wide enough to absorb transient relay blips without evicting live ext connections', () => {
    expect(BROWSER_PROXY_CONSTANTS.STALE_PURGE_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });

  it('purge threshold strictly exceeds the sweep interval so each instance gets multiple sweep checks before being purged', () => {
    // If the threshold equalled or undercut the interval, an instance could
    // be purged on the very same tick that would have refreshed it via a
    // pending heartbeat — that is the bug we are explicitly avoiding.
    expect(BROWSER_PROXY_CONSTANTS.STALE_PURGE_THRESHOLD_MS).toBeGreaterThan(
      BROWSER_PROXY_CONSTANTS.SWEEP_INTERVAL_MS,
    );
  });
});

describe('CLOUD_SYNC_CONSTANTS', () => {
  it('REGISTER_INTERVAL_MS gives the relay a chance to evict stale Portal pairs within a minute', () => {
    // The relay's stale-pair eviction only fires on register. If this
    // interval grows too long, a Portal user who closes their tab and
    // reopens in a new browser will sit `Cloud Active`-but-no-agents
    // until OSS happens to re-register. One minute is the slow side of
    // "tolerable" — keep it tight.
    expect(CLOUD_SYNC_CONSTANTS.REGISTER_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(CLOUD_SYNC_CONSTANTS.REGISTER_INTERVAL_MS).toBeLessThanOrEqual(120_000);
  });
});

describe('API_SECURITY_CONSTANTS (backend re-export)', () => {
  it('re-exports the cross-domain block so index.ts can read the bind host default', () => {
    expect(API_SECURITY_CONSTANTS.DEFAULT_BIND_HOST).toBe('0.0.0.0');
    expect(API_SECURITY_CONSTANTS.ENV.BIND_HOST).toBe('CREWLY_BIND_HOST');
  });
});

describe('RUNTIME_TYPES (opencode-cli, issue #306)', () => {
  it('registers OpenCode as a fourth PTY runtime next to claude/gemini/codex', () => {
    expect(RUNTIME_TYPES.OPENCODE_CLI).toBe('opencode-cli');
    expect(Object.values(RUNTIME_TYPES)).toEqual(
      expect.arrayContaining(['claude-code', 'gemini-cli', 'codex-cli', 'opencode-cli', 'crewly-agent']),
    );
  });

  it('has a compact command for every runtime type (Record<RuntimeType, string> is exhaustive)', () => {
    for (const type of Object.values(RUNTIME_TYPES)) {
      expect(typeof RUNTIME_COMPACT_COMMANDS[type]).toBe('string');
    }
    expect(RUNTIME_COMPACT_COMMANDS['opencode-cli']).toBe('/compact');
  });

  it('treats the OpenCode /connect provider dialog as a login-required screen', () => {
    const lower = 'connect a provider\n  anthropic\n  openai\n  other  custom provider';
    const matched = LOGIN_REQUIRED_PATTERN_SETS.some((set) =>
      set.every((pattern) => lower.includes(pattern.toLowerCase())),
    );
    expect(matched).toBe(true);
  });

  it('treats the OpenCode "Get started /connect" footer as a login-required screen', () => {
    const lower = '~/projects/demo                     get started /connect';
    const matched = LOGIN_REQUIRED_PATTERN_SETS.some((set) =>
      set.every((pattern) => lower.includes(pattern.toLowerCase())),
    );
    expect(matched).toBe(true);
  });

  it('marks the OpenCode busy hint and provider dialog as not-ready-for-input', () => {
    const markers = RUNTIME_INPUT_READY_PATTERNS.OPENCODE_CLI.NOT_READY_MARKERS;
    expect(markers).toContain('esc interrupt');
    expect(markers).toContain('esc again to interrupt');
    expect(markers).toContain('connect a provider');
    // Markers are lower-case + whitespace-collapsed by contract (isReadyForInput normalises the screen that way)
    for (const marker of markers) {
      expect(marker).toBe(marker.toLowerCase());
      expect(marker).not.toMatch(/\s{2,}/);
    }
  });
});

describe('GOOGLE_WORKSPACE_CONSTANTS', () => {
  it('points at the Cloud workspace-grant prefix the auth service mounts', () => {
    expect(GOOGLE_WORKSPACE_CONSTANTS.CLOUD_PATH).toBe('/api/cloud/google/workspace');
    expect(GOOGLE_WORKSPACE_CONSTANTS.CLOUD_ENDPOINTS.TOKEN).toBe('/token');
    expect(GOOGLE_WORKSPACE_CONSTANTS.CLOUD_ENDPOINTS.DISCONNECT).toBe('');
  });

  it('refreshes ahead of expiry by the same 60 s margin Cloud caches with', () => {
    expect(GOOGLE_WORKSPACE_CONSTANTS.TOKEN_REFRESH_MARGIN_MS).toBe(60_000);
  });

  it('talks to Google directly, never through Cloud', () => {
    expect(GOOGLE_WORKSPACE_CONSTANTS.GMAIL_API_BASE).toMatch(/^https:\/\/gmail\.googleapis\.com\//);
    expect(GOOGLE_WORKSPACE_CONSTANTS.CALENDAR_API_BASE).toMatch(/^https:\/\/www\.googleapis\.com\/calendar\//);
  });

  it('keeps defaults under their ceilings', () => {
    expect(GOOGLE_WORKSPACE_CONSTANTS.GMAIL_DEFAULT_MAX_RESULTS).toBeLessThanOrEqual(
      GOOGLE_WORKSPACE_CONSTANTS.GMAIL_MAX_RESULTS_CEILING,
    );
    expect(GOOGLE_WORKSPACE_CONSTANTS.CALENDAR_DEFAULT_MAX_RESULTS).toBeLessThanOrEqual(
      GOOGLE_WORKSPACE_CONSTANTS.CALENDAR_MAX_RESULTS_CEILING,
    );
  });
});

describe('SLACK_CLOUD_CONSTANTS (Slack v3 — Cloud owns Slack)', () => {
  it('uses the relay message type Cloud pushes Slack events with', () => {
    expect(SLACK_CLOUD_CONSTANTS.MESSAGE_TYPE).toBe('slack_event');
    expect(SLACK_CLOUD_CONSTANTS.CLOUD_DEVICE_NAME).toBe('crewly-cloud-slack');
  });

  it('refreshes the config every 10 minutes and heartbeats every 5', () => {
    expect(SLACK_CLOUD_CONSTANTS.CONFIG_REFRESH_INTERVAL_MS).toBe(10 * 60 * 1000);
    expect(SLACK_CLOUD_CONSTANTS.REGISTRY_HEARTBEAT_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(SLACK_CLOUD_CONSTANTS.TEAM_SAVED_DEBOUNCE_MS).toBeLessThan(SLACK_CLOUD_CONSTANTS.REGISTRY_HEARTBEAT_INTERVAL_MS);
  });

  it('addresses the contract paths under /api/cloud/slack', () => {
    expect(SLACK_CLOUD_CONSTANTS.CLOUD_PATH).toBe('/api/cloud/slack');
    expect(SLACK_CLOUD_CONSTANTS.CONFIG_PATH).toBe('/config');
    expect(SLACK_CLOUD_CONSTANTS.INSTANCES_PATH).toBe('/instances');
    expect(SLACK_CLOUD_CONSTANTS.AGENTS_SYNC_PATH).toBe('/agents/sync');
    expect(SLACK_CLOUD_CONSTANTS.INSTALL_PATH).toBe('/install');
    expect(SLACK_CLOUD_CONSTANTS.INSTALL_RETURN_PATH).toBe('/connections?platform=slack');
  });

  it('keeps file-share and thread-broadcast subtypes routable and nothing else', () => {
    expect([...SLACK_CLOUD_CONSTANTS.INBOUND_ALLOWED_SUBTYPES]).toEqual(['file_share', 'thread_broadcast']);
  });
});

describe('TRIGGER_ENGINE_CONSTANTS', () => {
  it('caps a single timer hop at exactly the Node 32-bit signed limit', () => {
    // 2^31 - 1: one more and setTimeout overflows to 1 ms with a warning.
    expect(TRIGGER_ENGINE_CONSTANTS.MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1);
  });
});

describe('CRON_SCHEDULE_CONSTANTS', () => {
  it('searches a full year so a once-a-year date is found, not fallen through', () => {
    expect(CRON_SCHEDULE_CONSTANTS.NEXT_RUN_HORIZON_DAYS).toBe(366);
  });

  it('keeps the day-skip buffer larger than any DST shift (1 h)', () => {
    expect(CRON_SCHEDULE_CONSTANTS.DAY_END_SKIP_BUFFER_MINUTES).toBeGreaterThan(60);
    expect(CRON_SCHEDULE_CONSTANTS.DAY_END_SKIP_BUFFER_MINUTES).toBeLessThan(24 * 60);
  });

  it('falls back by exactly one day for an impossible expression', () => {
    expect(CRON_SCHEDULE_CONSTANTS.IMPOSSIBLE_EXPRESSION_FALLBACK_MS).toBe(86_400_000);
  });
});

describe('MICROSOFT_TODO_CONSTANTS', () => {
  it('points at the Cloud `microsoft` grant and Graph v1.0, and returns to its Connections card', () => {
    expect(MICROSOFT_TODO_CONSTANTS.CONNECTOR_ID).toBe('microsoft-todo');
    expect(MICROSOFT_TODO_CONSTANTS.CLOUD_PATH).toBe('/api/cloud/microsoft');
    expect(MICROSOFT_TODO_CONSTANTS.GRAPH_BASE).toBe('https://graph.microsoft.com/v1.0');
    expect(MICROSOFT_TODO_CONSTANTS.SETTINGS_RETURN_PATH).toBe('/connections?platform=microsoft-todo');
    expect(MICROSOFT_TODO_CONSTANTS.TASKS_DEFAULT_LIMIT).toBeLessThanOrEqual(MICROSOFT_TODO_CONSTANTS.TASKS_LIMIT_CEILING);
  });
});

describe('SAFE_RESTART', () => {
  it('extends the shared budget with backend-only drain settings', async () => {
    const { SAFE_RESTART } = await import('./constants.js');
    expect(SAFE_RESTART.DRAIN_TIMEOUT_MS).toBe(120_000);
    expect(SAFE_RESTART.DRAIN_ENV_VAR).toBe('CREWLY_RESTART_DRAIN_MS');
    expect(SAFE_RESTART.TURN_QUIET_MS).toBeGreaterThan(SAFE_RESTART.TURN_START_GRACE_MS);
    expect(SAFE_RESTART.DRAIN_POLL_INTERVAL_MS).toBeLessThan(SAFE_RESTART.DRAIN_TIMEOUT_MS);
    expect(SAFE_RESTART.INTERRUPTED_TURNS_FILE).toBe('interrupted-turns.json');
    expect(SAFE_RESTART.RESUME_NOTICE).toMatch(/^\[CREWLY\] You were interrupted by a restart/);
  });
});

describe('TICKET_CONSTANTS / POOL_ARCHIVE_CONSTANTS (ticket loop)', () => {
  it('ticket numbering, counter file and receipt texts', async () => {
    const { TICKET_CONSTANTS } = await import('./constants.js');
    expect(TICKET_CONSTANTS.NUMBER_PREFIX).toBe('TKT-');
    expect(TICKET_CONSTANTS.NUMBER_PAD).toBe(3);
    // No `.json`: RequestService.listAll must never read the counter as a Request.
    expect(TICKET_CONSTANTS.COUNTER_FILENAME.endsWith('.json')).toBe(false);
    expect(TICKET_CONSTANTS.RECEIPT.RECORDED('TKT-001')).toBe('已记成 TKT-001');
    expect(TICKET_CONSTANTS.RECEIPT.DISMISSED('TKT-001')).toBe('TKT-001 已取消记录');
    expect(TICKET_CONSTANTS.DISMISS_PATTERN.test('不用记')).toBe(true);
    expect(TICKET_CONSTANTS.DISMISS_PATTERN.test('不用记这个')).toBe(false);
    expect(TICKET_CONSTANTS.INTAKE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('archive: 7 days, terminal statuses, marker file', async () => {
    const { POOL_ARCHIVE_CONSTANTS } = await import('./constants.js');
    expect(POOL_ARCHIVE_CONSTANTS.MIN_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect([...POOL_ARCHIVE_CONSTANTS.TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'done', 'failed', 'verified']);
    expect(POOL_ARCHIVE_CONSTANTS.MARKER_FILENAME).toBe('.archived-2026-09-ticket-loop');
  });
});

describe('WHATSAPP_CONSTANTS (inbox connector)', () => {
  it('defaults dashboard connects to inbox mode (owner decision) and the env path to assistant', () => {
    expect(WHATSAPP_CONSTANTS.DEFAULT_CONNECT_MODE).toBe(WHATSAPP_CONSTANTS.MODES.INBOX);
    expect(WHATSAPP_CONSTANTS.LEGACY_ENV_MODE).toBe(WHATSAPP_CONSTANTS.MODES.ASSISTANT);
  });

  it('gives agents a 30-minute confirm window', () => {
    expect(WHATSAPP_CONSTANTS.DRAFT_CONFIRM_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('confirm pattern captures the draft code', () => {
    const p = WHATSAPP_CONSTANTS.DRAFT_CONFIRM_PATTERN;
    expect(p.exec('发 W12')?.[2]).toBe('W12');
    expect(p.exec('确认发送 #12')?.[2]).toBe('12');
    expect(p.test('发 W12 please')).toBe(false);
  });

  it('matches the Baileys FULL history-sync enum value', () => {
    expect(WHATSAPP_CONSTANTS.HISTORY_SYNC_TYPE_FULL).toBe(2);
  });
});

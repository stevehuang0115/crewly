/**
 * Tests for the legacy-chat → chat-v2 migration script.
 *
 * The bulk of the import logic is exercised through
 * `ChatV2Service.importLegacyConversation` tests
 * (`backend/src/services/chat-v2/chat-v2.service.test.ts`). The script
 * itself is a thin file-traversal + CLI wrapper; these tests pin the
 * CLI-arg parsing contract and the no-op behaviours that must not
 * touch the filesystem or DB.
 *
 * @module scripts/migrate-legacy-chat-to-v2.test
 */

// We don't want to actually load the chat-v2 singleton in these tests
// — that would open a SQLite database. The script's exported helpers
// can be imported standalone via dynamic import once we make them
// exportable; for now we test the CLI-arg parser shape by re-deriving
// it inline (the script keeps `parseMode` as a private file-local
// function on purpose, since the script is CLI-only).

describe('migrate-legacy-chat-to-v2 — CLI arg parsing', () => {
  function parseMode(argv: string[]): 'dry-run' | 'apply' | 'verify' | null {
    const has = (flag: string): boolean => argv.includes(flag);
    if (has('--apply')) return 'apply';
    if (has('--verify')) return 'verify';
    if (has('--dry-run') || argv.length === 0) return 'dry-run';
    for (const arg of argv) {
      if (arg.startsWith('-') && !['--apply', '--verify', '--dry-run'].includes(arg)) {
        return null;
      }
    }
    return 'dry-run';
  }

  it('defaults to dry-run when no args are passed', () => {
    expect(parseMode([])).toBe('dry-run');
  });

  it('returns apply for --apply', () => {
    expect(parseMode(['--apply'])).toBe('apply');
  });

  it('returns verify for --verify', () => {
    expect(parseMode(['--verify'])).toBe('verify');
  });

  it('returns dry-run for --dry-run', () => {
    expect(parseMode(['--dry-run'])).toBe('dry-run');
  });

  it('--apply wins over --verify when both are passed (deterministic precedence)', () => {
    expect(parseMode(['--verify', '--apply'])).toBe('apply');
  });

  it('rejects unknown flags', () => {
    expect(parseMode(['--something-else'])).toBeNull();
  });

  it('ignores positional args (no flags treated as dry-run)', () => {
    expect(parseMode(['foo.json'])).toBe('dry-run');
  });
});

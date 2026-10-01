# Runtime Terms consent (owner agrees from a Slack card)

Status: implemented (OSS `feat/runtime-terms-consent`)
Date: 2026-10-01

## Why

Antigravity CLI (`agy`, runtime `antigravity-cli`) shows Google's Terms of Service once, on its
first interactive launch on a machine. Until now Crewly could only stop and say "run `agy` in a
terminal and finish those screens". That is a terminal step for an owner who is usually on a
phone (see the owner-away rule).

**Rule:** the harness never accepts third-party Terms on its own. The owner decides, and the
harness then performs exactly that choice on the screen.

## 1. Detection → one card

A runtime's first-run Terms screen is detected in three places:

| Where | How |
|---|---|
| Agent launch | `AntigravityRuntimeService.waitForRuntimeReady` hits `first_run_setup` |
| Smoke test | `RuntimeSmokeTestService` fails with "Antigravity needs its terms accepted once" (`onTermsScreen`) |
| Probe | `POST /api/system/runtime-terms/:runtime/probe` (Settings → **Check**): launch once, read the first screen, press nothing |

Each detection calls `RuntimeTermsConsentService.reportTermsScreen(runtime, { source, ownerInitiated })`.
It creates **one** pending decision per runtime per machine (`~/.crewly/runtime-terms-consent.json`
holds one record per runtime). Concurrent reports, such as a launch and a smoke test together, are
serialised. A pending card that is still open is reused.

The card is a decision card (`specs/2026-10-01-decision-cards.md`) asked by the harness itself
(`DecisionService.askSystem`):

- `kind: 'runtime_terms'`, `system: { key: <runtime>, defaultIsDecline: true }`, `sensitive: 'runtime_terms'`
- posted in the **owner's DM with this machine's orc bot** (`ownerDmOf`), not in a team channel
- header `Antigravity CLI · Terms of Service (<machine>)`
- question: `Antigravity CLI on <machine> needs Google's Terms of Service accepted once before it can run. Do you agree?`
- body: a one-line plain-English summary of what is asked (the Terms, the Privacy Policy and the
  security warning); the two links; and the pre-checked data-sharing item, quoted **separately**
- buttons: **Agree, no data sharing** · **Agree + share data** · **Don't agree** (no snooze button)
- deadline 24 h; default **Don't agree**. A sensitive decision is normally never applied at its
  deadline. This one is the exception, because its default declines and declining is always safe.

Answers:
- a button, or the inline choice in Settings;
- a thread reply that names an option (its label, letter or number);
- ❌ or a "no" word, which means Don't agree.

✅, "yes" and other free text are **not** answers, because there are two ways to agree. A system
decision never wakes or messages an agent. Only the `runtime_terms` decision-kind handler acts on
it: `RuntimeTermsConsentService`, registered with `DecisionService.registerKindHandler` (the same
mechanism held browser actions use), called once per settlement: resolved, defaulted, cancelled or
expired.

## 2. On the answer: drive the TUI deterministically

**Agree** (either kind). The harness launches the runtime in its own PTY session
`crewly-terms-<runtime>`. It uses the session backend that agent PTYs use, the same pre-launch
guard (Gemini API key provider, folder trusted), the key in the spawn environment, and a 120×40
size. It then drives the screens with `driveAntigravityTerms`. One key at a time: it reads and
parses the screen before every key (`parseAntigravityTermsScreen`).

The agy 1.2.14 screens, captured from the real binary, and what the driver does on each:

| Screen | Driver |
|---|---|
| Colour scheme (focus `> name`, chosen `* name`) | Moves the focus to `terminal` with ↑ and presses Enter |
| Migration options (only when Gemini CLI extensions exist) | Leaves "Import extensions from Gemini CLI" unchecked. Presses Enter on Next only when the screen shows `* terminal` and the box unchecked |
| Terms (`> [x] Yes, I agree to help improve…`, buttons `[Previous] [Done]`; a focused button loses its brackets) | Toggles the data box (Enter) only if it differs from the choice, then reads the screen again to check. Goes to Done with ↓ and →. Reads the screen once more right before Enter, and presses Enter on Done only if the box still matches the choice |
| Folder trust | Enter (the pre-selected "Yes, I trust this folder") |
| Main prompt (`? for shortcuts`) | Finished |

**Robustness.** Screens are matched by text, never by a key count. The driver aborts and does
**not** press Done when any of these happens:
- an unknown screen lasts 20 s;
- the checkbox cannot be read (for example, the wording changed);
- an account sign-in screen appears;
- the run reaches 60 keys;
- the Terms screen changes between the last check and Done.

On an abort, the thread gets the reason and the redacted screen text in a code block. After Done,
the prompt must appear within 90 s.

Next, the harness closes the session (Ctrl+C twice, then kills it) and runs the runtime smoke test.
Both results go to the card's thread:
- `Accepted on <machine>: Antigravity CLI's Terms, data sharing off (checked on screen before Done)…`
- `Runtime test passed in 42s…` or `Runtime test failed at "<step>": …`

If the runtime opens straight to its prompt, its Terms were already accepted, so nothing is
pressed. That is reported, and the smoke test still runs.

**Don't agree** (button or deadline). The harness kills the dedicated session if one exists and
records `declined` with the reason (`You chose Don't agree`, or `No answer within 24 h, so the
default (Don't agree) applied`). It says in the thread how to change your mind.

## 3. Fallback chains skip it

`computeRuntimeAvailability` takes a `termsBlocked(runtime)` lookup, which the wiring reads from the
consent service. A runtime is marked `selectable: false, termsBlocked: true` when its record is in
one of these states:

- `pending` (waiting for the owner);
- `accepting`;
- `declined`;
- `failed`.

The reason is shown in Settings → Runtimes (for example `Terms not accepted: You chose Don't
agree`). `pickFallback` already skips runtimes that are not selectable. The availability cache is
dropped whenever a consent record changes.

The owner is asked again **only** in these cases:
- they press **Test** (smoke test with `ownerInitiated`);
- they **re-add** the runtime to a fallback order (`PUT /runtime-fallback/settings` adds a
  runtime that is terms-blocked);
- they use **Accept terms…** or **Check**.

A launch or an automatic smoke test never re-asks after Don't agree.

## 4. Settings → Runtimes → Terms of Service

`RuntimeTermsPanel` lists every runtime that has a Terms flow, with its state:
- not seen yet;
- waiting for your answer;
- accepting;
- accepted, with data sharing on or off;
- not accepted, with the reason.

It has two actions:
- **Accept terms…** (`POST …/request`) posts the same card and opens the same three choices
  inline. It shows the summary, the links and the data item separately. An inline answer
  (`POST …/answer { choice }`) goes through the open card, so the card updates too.
- **Check** (`POST …/probe`).

In the fallback editor, a terms-blocked runtime can still be added and tested; either action asks
again. All of these endpoints refuse agent sessions (`X-Agent-Session` → 403), because agents never
accept Terms.

## 5. Tests

- `antigravity-terms-screens.test.ts`: the parser against the real captured screens.
- `fake-agy-tui.fixture.ts` (tests only): a scripted terminal. It takes the raw bytes a PTY would
  get, renders the same screens with the same focus behaviour (including ↑ from the import item
  jumping to the bottom of the list), and records every key and what Done accepted.
- `antigravity-terms-driver.test.ts` covers:
  - each choice: the exact keys sent and the accepted checkbox state;
  - the migration screen;
  - getting back to the default scheme;
  - already accepted;
  - changed wording → abort without Done;
  - a stuck checkbox → key budget → abort;
  - an account sign-in;
  - a race just before Done;
  - no prompt after Done.
- `runtime-terms-consent.service.test.ts`, over the real `DecisionService` with a fake Slack, covers:
  - detection → one card (in the DM, from the orc bot, with three buttons and no snooze);
  - each button driving the fake TUI;
  - Don't agree, then re-asking only when owner-initiated;
  - a mismatch → abort, never Done, screen in the thread;
  - the deadline → Don't agree;
  - an inline answer through the card;
  - ✅ / "yes" ignored and ❌ meaning Don't agree;
  - English-only text;
  - the probe.
- Fallback: `runtime-availability.test.ts` and `runtime-fallback.service.test.ts` check that a
  terms-blocked runtime is skipped in the chain.
- `runtime-fallback.controller.test.ts` checks that re-adding a runtime re-asks and that Test is
  owner-initiated.
- `runtime-smoke-test.service.test.ts` checks the `onTermsScreen` report.
- `antigravity-runtime.service.test.ts` checks the launch report.
- `decision-*.test.ts` covers system decisions.
- Frontend: `RuntimeTermsPanel.test.tsx` and `RuntimeFallbackPanel.test.tsx`.

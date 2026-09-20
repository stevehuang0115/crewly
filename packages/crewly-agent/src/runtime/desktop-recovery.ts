/**
 * Surprises, and what to do about them.
 *
 * Phase 4 of docs/research/computer-use-capability-assessment.md, §5.7. The
 * second failure in §5.1 is the expensive one: at step 15 a dialog appears,
 * the agent does not notice, and the next twenty steps act on a state that no
 * longer exists. Every one of them looks fine in isolation.
 *
 * The surprises are not open-ended. A desktop throws the same handful over
 * and over — a modal sheet, a permission prompt, a beachballing app, focus
 * landing somewhere else, a login wall. Naming them means the agent gets a
 * specific instruction instead of having to work out from a screenshot that
 * something is wrong at all.
 *
 * @module runtime/desktop-recovery
 */

/** What went unexpectedly wrong. */
export type SurpriseKind =
  /** A sheet or modal is waiting for an answer. */
  | 'modal-dialog'
  /** macOS is asking the user to allow something. */
  | 'permission-prompt'
  /** A sign-in wall. */
  | 'login-required'
  /** The app stopped responding. */
  | 'app-not-responding'
  /** Another application took the front. */
  | 'focus-lost'
  /** The screen was locked mid-task. */
  | 'screen-locked';

/** A surprise, and the instruction that goes with it. */
export interface Surprise {
  kind: SurpriseKind;
  /** What was seen, for the log and for the agent. */
  detail: string;
  /** What the agent should do next, in one instruction. */
  instruction: string;
  /**
   * Whether the agent can deal with this itself. False means a person has to
   * — there is no point spending the budget discovering that.
   */
  selfRecoverable: boolean;
}

/** An element as a snapshot reports it. */
export interface SceneElement {
  role: string;
  name?: string;
  subrole?: string;
}

/** Enough of the world to spot a surprise in. */
export interface Scene {
  app?: string;
  elements: SceneElement[];
  /** Whatever the last action answered, when it failed. */
  lastFailure?: { reason?: string; message?: string };
}

/** Button labels that mean "a modal is waiting". */
const MODAL_ROLES = new Set(['AXSheet', 'AXDialog']);

/** Words that mark a sign-in wall rather than an ordinary form. */
const LOGIN_WORDS = ['sign in', 'log in', 'login', 'password', 'two-factor', 'verification code', '验证码', '登录'];

/** Words macOS uses when it wants the user to allow something. */
const PERMISSION_WORDS = ['would like to access', 'wants access', 'allow', 'grant access', '访问'];

/**
 * Look at a scene and name what is wrong with it, if anything.
 *
 * Order matters: the checks run from most specific to least, because a
 * permission prompt *is* a modal dialog and the specific instruction is the
 * useful one.
 *
 * @param scene - What is on screen, plus the last failure if there was one
 * @param expectedApp - The app the agent believes it is working in
 * @returns The surprise, or null when the scene looks ordinary
 *
 * @example
 * detectSurprise({ app: 'TextEdit', elements: [{ role: 'AXSheet', name: 'Save changes?' }] })
 * // → { kind: 'modal-dialog', instruction: 'Answer the dialog…' }
 */
export function detectSurprise(scene: Scene, expectedApp?: string): Surprise | null {
  // A rail already said what was wrong; it outranks anything inferred.
  const failure = scene.lastFailure?.reason;
  if (failure === 'screen_locked') {
    return {
      kind: 'screen-locked',
      detail: 'The screen was locked.',
      instruction: 'Stop and report that the screen is locked. It cannot be unlocked from here.',
      selfRecoverable: false,
    };
  }

  const named = scene.elements.filter((e) => e.name);
  const textOf = (e: SceneElement) => (e.name ?? '').toLowerCase();

  // A permission prompt is a modal, so it has to be checked first.
  const permission = named.find((e) => PERMISSION_WORDS.some((w) => textOf(e).includes(w)));
  if (permission && named.some((e) => MODAL_ROLES.has(e.role))) {
    return {
      kind: 'permission-prompt',
      detail: `macOS is asking: "${permission.name}"`,
      instruction:
        'A macOS permission prompt is open. Do not answer it — granting access on the owner\'s behalf is their decision. ' +
        'Stop and tell them what is being asked for.',
      selfRecoverable: false,
    };
  }

  const login = named.find((e) => LOGIN_WORDS.some((w) => textOf(e).includes(w)));
  if (login) {
    return {
      kind: 'login-required',
      detail: `A sign-in is being asked for: "${login.name}"`,
      instruction:
        'This needs credentials, which desktop control never enters. Stop and ask the owner to sign in, then continue.',
      selfRecoverable: false,
    };
  }

  const modal = scene.elements.find((e) => MODAL_ROLES.has(e.role));
  if (modal) {
    const buttons = named.filter((e) => e.role === 'AXButton').map((e) => e.name!);
    return {
      kind: 'modal-dialog',
      detail: `A dialog is open${modal.name ? `: "${modal.name}"` : ''}.`,
      instruction:
        `A dialog is waiting for an answer and nothing else will work until it is dealt with. ` +
        (buttons.length
          ? `Its buttons are: ${buttons.join(', ')}. Choose the one that matches the task — if the task did not ask to save, do not save. `
          : 'Take a snapshot to see its buttons. ') +
        'Then take a fresh snapshot: the window behind it has probably changed.',
      selfRecoverable: true,
    };
  }

  if (scene.lastFailure?.reason === 'timeout') {
    return {
      kind: 'app-not-responding',
      detail: 'The last action timed out.',
      instruction:
        'The application is not responding. Wait for the screen to settle, then take a fresh snapshot before trying again. ' +
        'Do not repeat the action blindly — it may have gone through.',
      selfRecoverable: true,
    };
  }

  if (expectedApp && scene.app && scene.app.toLowerCase() !== expectedApp.toLowerCase()) {
    return {
      kind: 'focus-lost',
      detail: `${scene.app} is in front, not ${expectedApp}.`,
      instruction:
        `Focus moved to ${scene.app}. Bring ${expectedApp} back to the front and take a fresh snapshot — ` +
        'any refs from before are stale.',
      selfRecoverable: true,
    };
  }

  return null;
}

/**
 * Whether to keep trying after a surprise.
 *
 * Three attempts at the same kind is the limit. A desktop surprise that
 * survives three goes is not one more click away — it is something the agent
 * has misunderstood, and the cheapest next move is to say so.
 *
 * @param kind - What went wrong
 * @param alreadyTried - How many times this kind has been handled in this subgoal
 * @param selfRecoverable - From the surprise
 * @returns Whether to try again, and what to say when not
 */
export function shouldRetryAfter(
  kind: SurpriseKind,
  alreadyTried: number,
  selfRecoverable: boolean,
): { retry: boolean; escalation?: string } {
  if (!selfRecoverable) {
    return { retry: false, escalation: `${kind} needs a person — stop and report it rather than working around it.` };
  }
  if (alreadyTried >= 3) {
    return {
      retry: false,
      escalation:
        `The same problem (${kind}) has come back three times. Stop and report what you tried and what you see — ` +
        'a fourth attempt will not be different.',
    };
  }
  return { retry: true };
}

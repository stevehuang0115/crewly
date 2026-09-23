# design-sync notes — @crewly/ui

- Run from `crewly/packages/ui`. Build: `npm run build` (tsup + Tailwind v3 → `dist/styles.css`), then the converter with `--node-modules ../../node_modules --entry ./dist/index.js` (deps are hoisted to the crewly workspace root).
- Playwright must be **1.58.2** in `.ds-sync/` — it matches the cached chromium build 1208 in `~/Library/Caches/ms-playwright`.
- Crewly is dark-only. The card harness forces a white body, so every preview is wrapped by `cfg.provider` = `CrewlyRoot` (a real export: dark surface + Nunito). Without it text is unreadable.
- The package ships compiled CSS (`dist/styles.css`, `cfg.cssEntry`). Tailwind scans `src/` **and `.design-sync/previews/`**; a layout class used only in a preview doesn't exist unless the build scanned it — rebuild the package (`npm run build`) after editing previews, then the converter.
- `tailwind.config.cjs` safelists the token utilities and a layout vocabulary for the design agent; `conventions.md` enumerates it — keep the two in step.
- Several components used global CSS class names that were never defined anywhere (`modal-*`, `form-*`, `toggle-*`, `score-card*` lived only partly in the OSS app's index.css). They now carry their Tailwind styles inline; the old names remain as hooks.
- Overlays (`Modal`, `Popup`, `FormPopup`, `ConfirmPopup`, `AlertDialog`, `ConfirmDialog`, `ModalBody`) use `fixed inset-0`; their previews wrap them in an `h-[460px]` stage so the backdrop has something to fill (`cardMode: single`).
- `OverflowMenu` and `Dropdown` open on click; their open states can't render statically — the cards show the closed trigger.
- Icons: `.design-sync/icons-entry.js` exposes a curated lucide set as `window.CrewlyUI.Icons` (bundle-only, `componentSrcMap: {Icons: null}` keeps it out of the card list). Add icons there when designs need them.
- Components are grouped via `docs/groups/<Group>.md` stubs (frontmatter `category` only) mapped in `docsMap`.

## Known render warns
- none

## Re-sync risks
- Token values live in three places: `theme.css` (v4), `tailwind-preset.cjs` (v3), `src/styles.css` (`--crewly-*` vars). `src/tokens.test.ts` checks the first two; the CSS vars are not tested.
- The layout safelist in `tailwind.config.cjs` is what `conventions.md` promises — trimming one without the other makes the design agent write classes that don't resolve.
- The web portal vendors this package (`web/scripts/sync-crewly-ui.sh`); a change here reaches Cloud only after that script is re-run and web is redeployed.
- `Button.test.tsx > should apply loading text class when loading` was already failing before the package was extracted.

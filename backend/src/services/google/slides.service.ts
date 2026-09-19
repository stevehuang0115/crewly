/**
 * SlidesService — Google Slides over the owner's Workspace grant.
 *
 * Reads any presentation the owner can see (`drive.readonly`) and builds
 * new decks from an outline (`drive.file`). Each outline slide becomes a
 * TITLE_AND_BODY slide with the title and bullet lines; the deck's default
 * first slide is removed so the outline is the whole deck.
 *
 * @module services/google/slides.service
 */

import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import { GoogleWorkspaceError } from './google-workspace-token.service.js';
import { buildGoogleUrl, googleRequest, type GoogleApiDeps } from './google-api.client.js';
import { requireId } from './drive.service.js';

/** One slide, flattened. */
export interface SlideText {
  index: number;
  objectId: string;
  /** Every text line on the slide, in reading order. */
  lines: string[];
  notes?: string;
}

/** A presentation, flattened. */
export interface PresentationText {
  id: string;
  title: string;
  slideCount: number;
  slides: SlideText[];
  webViewLink: string;
}

/** One slide of an outline. */
export interface SlideOutline {
  title: string;
  /** Body lines; each becomes one paragraph (bulleting is the layout's default). */
  bullets?: string[];
  /** Speaker notes are not written (the Slides API needs the notes shape id) — kept for callers' bookkeeping. */
  notes?: string;
}

/** Create input. */
export interface PresentationCreateInput {
  title: string;
  slides: SlideOutline[];
}

interface WireTextElement {
  textRun?: { content?: string };
}
interface WirePageElement {
  shape?: { text?: { textElements?: WireTextElement[] } };
  table?: { tableRows?: Array<{ tableCells?: Array<{ text?: { textElements?: WireTextElement[] } }> }> };
  elementGroup?: { children?: WirePageElement[] };
}
interface WirePage {
  objectId?: string;
  pageElements?: WirePageElement[];
  slideProperties?: { notesPage?: { pageElements?: WirePageElement[] } };
}
interface WirePresentation {
  presentationId?: string;
  title?: string;
  slides?: WirePage[];
}

/**
 * Lines of text in a page element (shape text, table cells, groups).
 *
 * @param el - Page element
 * @returns Non-empty lines
 */
export function elementLines(el: WirePageElement): string[] {
  const out: string[] = [];
  const pushText = (elements: WireTextElement[] | undefined) => {
    const raw = (elements ?? []).map((t) => t.textRun?.content ?? '').join('');
    for (const line of raw.split('\n')) if (line.trim()) out.push(line.trim());
  };
  if (el.shape?.text) pushText(el.shape.text.textElements);
  for (const row of el.table?.tableRows ?? []) {
    const cells = (row.tableCells ?? []).map((c) => (c.text?.textElements ?? []).map((t) => t.textRun?.content ?? '').join('').trim());
    if (cells.some(Boolean)) out.push(cells.join(' | '));
  }
  for (const child of el.elementGroup?.children ?? []) out.push(...elementLines(child));
  return out;
}

/**
 * Flatten a presentation.
 *
 * @param wire - `presentations.get` payload
 * @returns Title + slides as text
 */
export function toPresentationText(wire: WirePresentation): PresentationText {
  const id = wire.presentationId ?? '';
  const slides = (wire.slides ?? []).map((page, i) => {
    const lines = (page.pageElements ?? []).flatMap(elementLines);
    const notes = (page.slideProperties?.notesPage?.pageElements ?? []).flatMap(elementLines).join('\n');
    return { index: i + 1, objectId: page.objectId ?? '', lines, ...(notes ? { notes } : {}) };
  });
  return { id, title: wire.title ?? '', slideCount: slides.length, slides, webViewLink: slidesLink(id) };
}

/**
 * The batchUpdate requests that turn an outline into slides.
 *
 * @param outline - Slides to add
 * @param removeSlideId - Object id of the default slide to delete, if any
 * @returns Requests in order (creates, inserts, then the delete)
 */
export function buildSlideRequests(outline: SlideOutline[], removeSlideId?: string): unknown[] {
  const requests: unknown[] = [];
  outline.forEach((slide, i) => {
    const slideId = `crewly_slide_${i + 1}`;
    const titleId = `${slideId}_title`;
    const bodyId = `${slideId}_body`;
    requests.push({
      createSlide: {
        objectId: slideId,
        insertionIndex: i,
        slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId },
          { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: bodyId },
        ],
      },
    });
    const title = (slide.title ?? '').trim();
    if (title) requests.push({ insertText: { objectId: titleId, insertionIndex: 0, text: title } });
    const body = (slide.bullets ?? []).map((b) => String(b).trim()).filter(Boolean).join('\n');
    if (body) requests.push({ insertText: { objectId: bodyId, insertionIndex: 0, text: body } });
  });
  if (removeSlideId) requests.push({ deleteObject: { objectId: removeSlideId } });
  return requests;
}

/**
 * Slides: read, create from outline.
 */
export class SlidesService {
  private readonly deps: GoogleApiDeps;
  private readonly base = GOOGLE_WORKSPACE_CONSTANTS.SLIDES_API_BASE;

  /**
   * @param deps - Token provider and optional fetch override
   */
  constructor(deps: GoogleApiDeps) {
    this.deps = deps;
  }

  /**
   * `presentations.get`, flattened to text per slide.
   *
   * @param id - Presentation id
   * @returns Title + slides
   */
  async read(id: string): Promise<PresentationText> {
    const presentationId = requireId(id);
    const wire = await googleRequest<WirePresentation>(
      this.deps,
      buildGoogleUrl(`${this.base}/presentations/${encodeURIComponent(presentationId)}`, {
        fields: 'presentationId,title,slides(objectId,pageElements,slideProperties.notesPage.pageElements)',
      }),
    );
    return toPresentationText(wire);
  }

  /**
   * `presentations.create` + one `batchUpdate` that adds every outline
   * slide and removes the default blank one.
   *
   * @param input - Title and outline
   * @returns The new deck, flattened (as read back from Google)
   * @throws GoogleWorkspaceError(400, validation) without a title / slides, or too many slides
   */
  async create(input: PresentationCreateInput): Promise<PresentationText> {
    const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
    const title = (input.title ?? '').trim();
    if (!title) throw new GoogleWorkspaceError(400, CODES.VALIDATION, '"title" is required');
    const outline = Array.isArray(input.slides) ? input.slides.filter((s) => s && typeof s === 'object') : [];
    if (outline.length === 0) throw new GoogleWorkspaceError(400, CODES.VALIDATION, '"slides" must be a non-empty array of {title, bullets[]}');
    if (outline.length > GOOGLE_WORKSPACE_CONSTANTS.SLIDES_MAX_SLIDES) {
      throw new GoogleWorkspaceError(400, CODES.VALIDATION, `"slides" exceeds ${GOOGLE_WORKSPACE_CONSTANTS.SLIDES_MAX_SLIDES}`);
    }
    const created = await googleRequest<WirePresentation>(this.deps, `${this.base}/presentations`, { method: 'POST', body: { title } });
    const presentationId = created.presentationId ?? '';
    const defaultSlide = created.slides?.[0]?.objectId;
    await googleRequest(this.deps, `${this.base}/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, {
      method: 'POST',
      body: { requests: buildSlideRequests(outline, defaultSlide) },
    });
    return this.read(presentationId);
  }
}

/**
 * Browser link for a presentation.
 *
 * @param id - Presentation id
 * @returns URL
 */
export function slidesLink(id: string): string {
  return `https://docs.google.com/presentation/d/${id}/edit`;
}

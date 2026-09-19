/**
 * Tests for SlidesService — page flattening (shapes, tables, groups,
 * notes), outline → batchUpdate requests, create then read back.
 *
 * @module services/google/slides.service.test
 */

import { SlidesService, buildSlideRequests, elementLines, toPresentationText } from './slides.service.js';
import type { GoogleApiDeps } from './google-api.client.js';

const BASE = 'https://slides.googleapis.com/v1';

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const shape = (text: string) => ({ shape: { text: { textElements: [{ textRun: { content: text } }] } } });

let fetchMock: jest.Mock;
let slides: SlidesService;

beforeEach(() => {
  fetchMock = jest.fn();
  const deps: GoogleApiDeps = {
    tokens: { getAccessToken: jest.fn().mockResolvedValue('ya29.tok'), clearCache: jest.fn() },
    fetchImpl: fetchMock as unknown as typeof fetch,
  };
  slides = new SlidesService(deps);
});

describe('flattening', () => {
  it('collects shape lines, table rows and grouped children; notes come from the notes page', () => {
    expect(elementLines({ elementGroup: { children: [shape('a\nb\n'), { table: { tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: 'x' } }] } }, { text: { textElements: [{ textRun: { content: 'y' } }] } }] }] } }] } })).toEqual(['a', 'b', 'x | y']);
    const out = toPresentationText({
      presentationId: 'p1',
      title: 'Deck',
      slides: [{ objectId: 's1', pageElements: [shape('Title\n'), shape('- one\n')], slideProperties: { notesPage: { pageElements: [shape('say hi')] } } }, { objectId: 's2', pageElements: [] }],
    });
    expect(out).toEqual({
      id: 'p1',
      title: 'Deck',
      slideCount: 2,
      slides: [{ index: 1, objectId: 's1', lines: ['Title', '- one'], notes: 'say hi' }, { index: 2, objectId: 's2', lines: [] }],
      webViewLink: 'https://docs.google.com/presentation/d/p1/edit',
    });
  });
});

describe('buildSlideRequests', () => {
  it('creates a TITLE_AND_BODY slide per outline entry with mapped placeholders, inserts text, then deletes the default slide', () => {
    const reqs = buildSlideRequests([{ title: 'Intro', bullets: ['a', ' ', 'b'] }, { title: '', bullets: [] }], 'default1');
    expect(reqs).toEqual([
      {
        createSlide: {
          objectId: 'crewly_slide_1',
          insertionIndex: 0,
          slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: 'crewly_slide_1_title' },
            { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: 'crewly_slide_1_body' },
          ],
        },
      },
      { insertText: { objectId: 'crewly_slide_1_title', insertionIndex: 0, text: 'Intro' } },
      { insertText: { objectId: 'crewly_slide_1_body', insertionIndex: 0, text: 'a\nb' } },
      {
        createSlide: {
          objectId: 'crewly_slide_2',
          insertionIndex: 1,
          slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: 'crewly_slide_2_title' },
            { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: 'crewly_slide_2_body' },
          ],
        },
      },
      { deleteObject: { objectId: 'default1' } },
    ]);
  });
});

describe('read / create', () => {
  it('reads with a field mask', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { presentationId: 'p1', title: 'D', slides: [] }));
    await expect(slides.read('p1')).resolves.toMatchObject({ id: 'p1', slideCount: 0 });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/presentations/p1?fields=presentationId%2Ctitle%2Cslides%28objectId%2CpageElements%2CslideProperties.notesPage.pageElements%29`);
  });

  it('creates the deck, applies the outline in one batchUpdate (removing the default slide) and reads it back', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { presentationId: 'n1', slides: [{ objectId: 'blank' }] }))
      .mockResolvedValueOnce(response(200, {}))
      .mockResolvedValueOnce(response(200, { presentationId: 'n1', title: 'Pitch', slides: [{ objectId: 'crewly_slide_1', pageElements: [shape('Why\n')] }] }));
    const out = await slides.create({ title: 'Pitch', slides: [{ title: 'Why', bullets: ['x'] }] });
    expect(out).toMatchObject({ id: 'n1', title: 'Pitch', slideCount: 1 });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ title: 'Pitch' });
    expect(fetchMock.mock.calls[1][0]).toBe(`${BASE}/presentations/n1:batchUpdate`);
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string) as { requests: unknown[] };
    expect(body.requests.at(-1)).toEqual({ deleteObject: { objectId: 'blank' } });
  });

  it('validates title, slides and the slide cap', async () => {
    await expect(slides.create({ title: '', slides: [{ title: 'a' }] })).rejects.toMatchObject({ code: 'validation' });
    await expect(slides.create({ title: 't', slides: [] })).rejects.toMatchObject({ code: 'validation' });
    await expect(slides.create({ title: 't', slides: Array.from({ length: 61 }, () => ({ title: 'a' })) })).rejects.toMatchObject({ code: 'validation' });
  });
});

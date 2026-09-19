/**
 * CanvaService — Canva Connect REST on the owner's grant.
 *
 * What agents can do: find designs, create a blank design (preset type or
 * custom size, optionally from an uploaded asset), export a design
 * (PDF / PNG / JPG / PPTX / GIF / MP4 — an async job, polled here to a
 * download URL), and upload images / videos as assets. Video *generation*
 * is not in the API: agents fill, duplicate and export, they do not render
 * from scratch. Brand templates need Canva Enterprise and are not wired.
 *
 * @module services/canva/canva.service
 */

import { CANVA_CONSTANTS } from '../../constants.js';
import { CanvaError } from './canva-token.service.js';

/** Token provider slice. */
export interface CanvaTokenProvider {
  getAccessToken(): Promise<string>;
  clearCache(): void;
}

/** Service dependencies. */
export interface CanvaApiDeps {
  tokens: CanvaTokenProvider;
  fetchImpl?: typeof fetch;
  /** Sleep between job polls (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A design, trimmed. */
export interface CanvaDesign {
  id: string;
  title: string;
  editUrl?: string;
  viewUrl?: string;
  thumbnailUrl?: string;
  pageCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** List input. */
export interface CanvaListInput {
  query?: string;
  ownership?: 'any' | 'owned' | 'shared';
  sortBy?: 'relevance' | 'modified_descending' | 'modified_ascending' | 'title_descending' | 'title_ascending';
  limit?: number;
  continuation?: string;
}

/** Create input. */
export interface CanvaCreateInput {
  title?: string;
  /** `doc` | `whiteboard` | `presentation` */
  preset?: string;
  /** Custom size in px (40–8000) */
  width?: number;
  height?: number;
  /** Start from an uploaded asset (image) */
  assetId?: string;
}

/** Export input. */
export interface CanvaExportInput {
  designId: string;
  format: string;
  /** JPG quality 1–100 (default 80) */
  quality?: number;
  /** MP4 quality preset, e.g. `horizontal_1080p` (default) */
  videoQuality?: string;
  /** Page numbers (1-based) */
  pages?: number[];
}

/** Export result. */
export interface CanvaExport {
  jobId: string;
  status: 'success' | 'failed' | 'in_progress';
  /** Download URLs (short-lived), one per file */
  urls: string[];
  error?: { code?: string; message?: string };
}

/** An uploaded asset. */
export interface CanvaAsset {
  id: string;
  name: string;
  thumbnailUrl?: string;
  createdAt?: string;
}

interface WireDesign {
  id?: string;
  title?: string;
  urls?: { edit_url?: string; view_url?: string };
  thumbnail?: { url?: string };
  page_count?: number;
  created_at?: number;
  updated_at?: number;
}

/**
 * Trim a Canva design resource.
 *
 * @param d - Wire design
 * @returns Trimmed
 */
export function toDesign(d: WireDesign): CanvaDesign {
  return {
    id: d.id ?? '',
    title: d.title ?? '',
    ...(d.urls?.edit_url ? { editUrl: d.urls.edit_url } : {}),
    ...(d.urls?.view_url ? { viewUrl: d.urls.view_url } : {}),
    ...(d.thumbnail?.url ? { thumbnailUrl: d.thumbnail.url } : {}),
    ...(d.page_count !== undefined ? { pageCount: d.page_count } : {}),
    ...(d.created_at ? { createdAt: new Date(d.created_at * 1000).toISOString() } : {}),
    ...(d.updated_at ? { updatedAt: new Date(d.updated_at * 1000).toISOString() } : {}),
  };
}

/**
 * The `format` object for an export job.
 *
 * @param input - Export input
 * @returns Canva format object
 * @throws CanvaError(400, validation) for an unknown format / bad quality
 */
export function buildExportFormat(input: CanvaExportInput): Record<string, unknown> {
  const CODES = CANVA_CONSTANTS.ERROR_CODES;
  const type = (input.format ?? '').trim().toLowerCase();
  if (!CANVA_CONSTANTS.EXPORT_FORMATS.includes(type)) {
    throw new CanvaError(400, CODES.VALIDATION, `format must be one of ${CANVA_CONSTANTS.EXPORT_FORMATS.join(', ')}`);
  }
  const pages = (input.pages ?? []).map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0);
  const format: Record<string, unknown> = { type, ...(pages.length ? { pages } : {}) };
  if (type === 'jpg') {
    const quality = input.quality ?? 80;
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new CanvaError(400, CODES.VALIDATION, 'quality must be 1–100');
    format.quality = quality;
  }
  if (type === 'mp4') format.quality = (input.videoQuality ?? '').trim() || 'horizontal_1080p';
  return format;
}

/**
 * Canva Connect calls.
 */
export class CanvaService {
  private readonly deps: Required<Pick<CanvaApiDeps, 'fetchImpl' | 'sleep' | 'now'>> & CanvaApiDeps;
  private readonly base = CANVA_CONSTANTS.API_BASE;

  /**
   * @param deps - Token provider, fetch, sleep
   */
  constructor(deps: CanvaApiDeps) {
    this.deps = {
      ...deps,
      fetchImpl: deps.fetchImpl ?? fetch,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: deps.now ?? (() => Date.now()),
    };
  }

  /**
   * `GET /designs` — search / list.
   *
   * @param input - Query, ownership, sort, limit, continuation
   * @returns Designs + continuation token
   */
  async listDesigns(input: CanvaListInput = {}): Promise<{ designs: CanvaDesign[]; continuation?: string }> {
    const limit = Math.min(Math.max(1, input.limit ?? CANVA_CONSTANTS.DESIGNS_DEFAULT_LIMIT), CANVA_CONSTANTS.DESIGNS_LIMIT_CEILING);
    const url = new URL(`${this.base}/designs`);
    url.searchParams.set('limit', String(limit));
    if (input.query?.trim()) url.searchParams.set('query', input.query.trim());
    if (input.ownership) url.searchParams.set('ownership', input.ownership);
    if (input.sortBy) url.searchParams.set('sort_by', input.sortBy);
    if (input.continuation) url.searchParams.set('continuation', input.continuation);
    const data = await this.request<{ items?: WireDesign[]; continuation?: string }>(url.toString());
    return { designs: (data.items ?? []).map(toDesign), ...(data.continuation ? { continuation: data.continuation } : {}) };
  }

  /**
   * `GET /designs/:id`.
   *
   * @param id - Design id
   * @returns The design
   */
  async getDesign(id: string): Promise<CanvaDesign> {
    const designId = (id ?? '').trim();
    if (!designId) throw new CanvaError(400, CANVA_CONSTANTS.ERROR_CODES.VALIDATION, '"id" is required');
    const data = await this.request<{ design?: WireDesign }>(`${this.base}/designs/${encodeURIComponent(designId)}`);
    return toDesign(data.design ?? {});
  }

  /**
   * `POST /designs` — a new design from a preset type, a custom size, or an asset.
   *
   * @param input - Title + type/size/asset
   * @returns The new design (with editUrl)
   * @throws CanvaError(400, validation) when neither a valid preset, size nor asset is given
   */
  async createDesign(input: CanvaCreateInput): Promise<CanvaDesign> {
    const CODES = CANVA_CONSTANTS.ERROR_CODES;
    const body: Record<string, unknown> = {};
    const title = (input.title ?? '').trim();
    if (title) body.title = title.slice(0, 255);
    const preset = (input.preset ?? '').trim().toLowerCase();
    if (preset) {
      if (!CANVA_CONSTANTS.PRESET_DESIGN_TYPES.includes(preset)) {
        throw new CanvaError(400, CODES.VALIDATION, `preset must be one of ${CANVA_CONSTANTS.PRESET_DESIGN_TYPES.join(', ')} (or give width/height)`);
      }
      body.design_type = { type: 'preset', name: preset };
    } else if (input.width !== undefined || input.height !== undefined) {
      const w = Number(input.width);
      const h = Number(input.height);
      if (![w, h].every((v) => Number.isInteger(v) && v >= 40 && v <= 8000)) {
        throw new CanvaError(400, CODES.VALIDATION, 'width and height must be integers between 40 and 8000');
      }
      body.design_type = { type: 'custom', width: w, height: h };
    }
    if (input.assetId?.trim()) body.asset_id = input.assetId.trim();
    if (!body.design_type && !body.asset_id) {
      throw new CanvaError(400, CODES.VALIDATION, 'give a preset (doc|whiteboard|presentation), a width+height, or an assetId');
    }
    const data = await this.request<{ design?: WireDesign }>(`${this.base}/designs`, { method: 'POST', body });
    return toDesign(data.design ?? {});
  }

  /**
   * `POST /exports` then poll `GET /exports/:id` until done.
   *
   * @param input - Design, format, options
   * @returns Download URLs (or the failure)
   */
  async exportDesign(input: CanvaExportInput): Promise<CanvaExport> {
    const designId = (input.designId ?? '').trim();
    if (!designId) throw new CanvaError(400, CANVA_CONSTANTS.ERROR_CODES.VALIDATION, '"designId" is required');
    const format = buildExportFormat(input);
    const started = await this.request<{ job?: WireJob }>(`${this.base}/exports`, { method: 'POST', body: { design_id: designId, format } });
    const job = await this.pollJob(`${this.base}/exports/${encodeURIComponent(started.job?.id ?? '')}`, started.job);
    return { jobId: job.id ?? '', status: job.status ?? 'failed', urls: job.urls ?? [], ...(job.error ? { error: job.error } : {}) };
  }

  /**
   * `POST /asset-uploads` (binary body) then poll `GET /asset-uploads/:id`.
   *
   * @param name - Asset name (≤ 50 chars)
   * @param bytes - File content
   * @returns The asset
   * @throws CanvaError(400, validation) for an empty/oversized file; 502 when the job fails
   */
  async uploadAsset(name: string, bytes: Buffer): Promise<CanvaAsset> {
    const CODES = CANVA_CONSTANTS.ERROR_CODES;
    const assetName = (name ?? '').trim().slice(0, 50);
    if (!assetName) throw new CanvaError(400, CODES.VALIDATION, '"name" is required');
    if (!bytes || bytes.length === 0) throw new CanvaError(400, CODES.VALIDATION, 'file is empty');
    if (bytes.length > CANVA_CONSTANTS.ASSET_MAX_BYTES) throw new CanvaError(400, CODES.VALIDATION, `file exceeds ${CANVA_CONSTANTS.ASSET_MAX_BYTES} bytes`);
    const started = await this.request<{ job?: WireJob }>(`${this.base}/asset-uploads`, {
      method: 'POST',
      rawBody: bytes,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Asset-Upload-Metadata': JSON.stringify({ name_base64: Buffer.from(assetName, 'utf8').toString('base64') }),
      },
    });
    const job = await this.pollJob(`${this.base}/asset-uploads/${encodeURIComponent(started.job?.id ?? '')}`, started.job);
    if (job.status !== 'success' || !job.asset) {
      throw new CanvaError(502, CODES.CANVA_ERROR, `Asset upload failed: ${job.error?.message ?? job.error?.code ?? job.status}`);
    }
    return {
      id: job.asset.id ?? '',
      name: job.asset.name ?? assetName,
      ...(job.asset.thumbnail?.url ? { thumbnailUrl: job.asset.thumbnail.url } : {}),
      ...(job.asset.created_at ? { createdAt: new Date(job.asset.created_at * 1000).toISOString() } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Poll a job until it leaves `in_progress` or the ceiling passes.
   *
   * @param url - Job URL
   * @param first - The job as returned by the create call
   * @returns The final job
   */
  private async pollJob(url: string, first: WireJob | undefined): Promise<WireJob> {
    let job: WireJob = first ?? {};
    const deadline = this.deps.now() + CANVA_CONSTANTS.JOB_POLL_TIMEOUT_MS;
    while (job.status === 'in_progress' && this.deps.now() < deadline) {
      await this.deps.sleep(CANVA_CONSTANTS.JOB_POLL_INTERVAL_MS);
      job = (await this.request<{ job?: WireJob }>(url)).job ?? {};
    }
    if (job.status === 'in_progress') {
      throw new CanvaError(504, CANVA_CONSTANTS.ERROR_CODES.CANVA_ERROR, `Canva job ${job.id ?? ''} is still running after ${CANVA_CONSTANTS.JOB_POLL_TIMEOUT_MS / 1000}s`);
    }
    return job;
  }

  /**
   * Authenticated call; 401 drops the cached token, 403/404/429 pass
   * through, other failures fold into 502.
   *
   * @param url - Absolute URL
   * @param init - Method / body / headers
   * @returns Parsed JSON
   */
  private async request<T>(url: string, init: { method?: 'GET' | 'POST'; body?: unknown; rawBody?: Buffer; headers?: Record<string, string> } = {}): Promise<T> {
    const CODES = CANVA_CONSTANTS.ERROR_CODES;
    const token = await this.deps.tokens.getAccessToken();
    let res: Response;
    try {
      res = await this.deps.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        body: init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
        signal: AbortSignal.timeout(CANVA_CONSTANTS.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new CanvaError(502, CODES.NETWORK, `Canva unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = `Canva request failed (${res.status})`;
      try {
        const parsed = JSON.parse(text) as { message?: string; code?: string };
        message = parsed.message ?? parsed.code ?? message;
      } catch {
        if (text) message = text.slice(0, 200);
      }
      if (res.status === 401) {
        this.deps.tokens.clearCache();
        throw new CanvaError(401, CODES.CANVA_ERROR, `Canva rejected the access token: ${message}`);
      }
      const passthrough = res.status === 403 || res.status === 404 || res.status === 429;
      throw new CanvaError(passthrough ? res.status : 502, CODES.CANVA_ERROR, message);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CanvaError(502, CODES.CANVA_ERROR, 'Canva returned a non-JSON response.');
    }
  }
}

interface WireJob {
  id?: string;
  status?: 'in_progress' | 'success' | 'failed';
  urls?: string[];
  asset?: { id?: string; name?: string; thumbnail?: { url?: string }; created_at?: number };
  error?: { code?: string; message?: string };
}

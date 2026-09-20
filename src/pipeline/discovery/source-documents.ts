/**
 * Every page this system fetches is persisted here, keyed by content hash.
 *
 * The hash is the analysis cache: if (url, contentHash) already exists the page
 * has not changed since we last looked at it, so no downstream analysis — and
 * in particular no LLM call — may run against it again.
 */
import { getDb } from '../../lib/db.js';
import { contentHash, newId } from '../../lib/hash.js';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('discovery:source-docs');

export type SourceType =
  | 'APP_LISTING'
  | 'PRICING_PAGE'
  | 'REVIEWS'
  | 'SEARCH_RESULT'
  | 'MERCHANT_SITE'
  | 'COMMUNITY';

export interface StoreSourceDocumentInput {
  url: string;
  sourceType: SourceType;
  /** Cleaned, boilerplate-free text. Raw HTML is deliberately not persisted. */
  text: string;
  opportunityId?: string | null;
  httpStatus?: number | null;
  metadata?: Record<string, unknown>;
}

export interface StoredSourceDocument {
  id: string;
  url: string;
  contentHash: string;
  /** False when this exact content was already stored — skip re-analysis. */
  isNew: boolean;
}

const MAX_TEXT_CHARS = 40_000;

export async function storeSourceDocument(
  input: StoreSourceDocumentInput,
): Promise<StoredSourceDocument> {
  const db = await getDb();
  const hash = contentHash(input.text);
  const text = input.text.slice(0, MAX_TEXT_CHARS);

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO source_documents
       (id, opportunity_id, url, source_type, content_hash, extracted_text, metadata_json, http_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (url, content_hash) DO NOTHING
     RETURNING id`,
    [
      newId('doc'),
      input.opportunityId ?? null,
      input.url,
      input.sourceType,
      hash,
      text,
      JSON.stringify(input.metadata ?? {}),
      input.httpStatus ?? null,
    ],
  );

  const newRow = inserted.rows[0];
  if (newRow) {
    return { id: newRow.id, url: input.url, contentHash: hash, isNew: true };
  }

  // Unchanged content. Attach it to an opportunity if we only now know which.
  if (input.opportunityId) {
    await db.query(
      `UPDATE source_documents SET opportunity_id = $1
        WHERE url = $2 AND content_hash = $3 AND opportunity_id IS NULL`,
      [input.opportunityId, input.url, hash],
    );
  }

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM source_documents WHERE url = $1 AND content_hash = $2 LIMIT 1',
    [input.url, hash],
  );
  const id = existing.rows[0]?.id ?? '';
  logger.debug('source document unchanged; skipping re-analysis', { url: input.url });
  return { id, url: input.url, contentHash: hash, isNew: false };
}

/** True when this exact content has been seen before, without writing a row. */
export async function isKnownContent(url: string, text: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    'SELECT id FROM source_documents WHERE url = $1 AND content_hash = $2 LIMIT 1',
    [url, contentHash(text)],
  );
  return res.rows.length > 0;
}

/** Re-attaches documents captured before the opportunity row existed. */
export async function linkSourceDocuments(urls: string[], opportunityId: string): Promise<void> {
  if (urls.length === 0) return;
  const db = await getDb();
  const placeholders = urls.map((_u, i) => `$${i + 2}`).join(',');
  await db.query(
    `UPDATE source_documents SET opportunity_id = $1
      WHERE opportunity_id IS NULL AND url IN (${placeholders})`,
    [opportunityId, ...urls],
  );
}

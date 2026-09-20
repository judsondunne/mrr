/**
 * Pilot signup handler — the only way a member of the public writes a
 * commitment row.
 *
 * Guarantees:
 *  - every field is validated with Zod before it reaches SQL;
 *  - all SQL is parameterized;
 *  - the submitted domain is normalized to exactly the same company_key form
 *    the gate counts, so one business can never be counted as two;
 *  - both commitment rows are written in ONE transaction and rely on the
 *    `commitments.dedupe_key` unique index, so a repeat submission from the
 *    same company is a no-op rather than a second vote.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { getDb, toNumber } from '@/lib/db';
import { newId } from '@/lib/hash';
import { createLogger } from '@/lib/logger';
import { normalizeDomain } from '@/app/_lib/domain';
import { clientKey, rateLimit } from '@/app/_lib/ratelimit';
import { cleanBlock, cleanText, formatPrice } from '@/app/_lib/text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const logger = createLogger('web:pilot');

/** Per instance, not global — see src/app/_lib/ratelimit.ts. */
const RATE_LIMIT = { capacity: 5, refillPerSecond: 5 / 60 };

const EMAIL_PATTERN = /^[^\s@,;<>()[\]\\]+@[^\s@,;<>()[\]\\]+\.[a-z]{2,}$/i;

const PilotSignupBody = z.object({
  slug: z.string().min(1).max(200),
  email: z.string().min(3).max(200).regex(EMAIL_PATTERN),
  domain: z.string().min(3).max(400),
  question: z.string().max(2000).optional(),
  priceAccepted: z.union([z.boolean(), z.string()]).optional(),
  /** Honeypot: a real person never sees this field. */
  website: z.string().max(200).optional(),
});

interface CampaignRow {
  id: string;
  opportunity_id: string;
  price_monthly: string | number;
  landing_slug: string;
}

function json(body: Record<string, unknown>, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(headers ?? {}) },
  });
}

function isChecked(value: boolean | string | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['on', 'true', 'yes', '1', 'checked'].includes(value.trim().toLowerCase());
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  try {
    if (contentType.includes('application/json')) {
      const parsed: unknown = await req.json();
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    }
    if (
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')
    ) {
      const form = await req.formData();
      const out: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) out[key] = typeof value === 'string' ? value : '';
      return out;
    }
    // No/unknown content type: try JSON, which is what the form component sends.
    const text = await req.text();
    if (!text.trim()) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const limit = rateLimit(`pilot:${clientKey(req)}`, RATE_LIMIT);
  if (!limit.allowed) {
    return json({ ok: false, error: 'RATE_LIMITED' }, 429, {
      'retry-after': String(limit.retryAfterSeconds),
    });
  }

  const raw = await readBody(req);
  if (!raw) return json({ ok: false, error: 'INVALID_INPUT' }, 400);

  const parsed = PilotSignupBody.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: 'INVALID_INPUT',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')).slice(0, 8),
      },
      400,
    );
  }
  const body = parsed.data;

  // Honeypot filled => automated submission. Nothing is written.
  if (cleanText(body.website, 200) !== '') {
    return json({ ok: false, error: 'INVALID_INPUT', fields: ['website'] }, 400);
  }

  const companyKey = normalizeDomain(body.domain);
  if (!companyKey) return json({ ok: false, error: 'INVALID_INPUT', fields: ['domain'] }, 400);

  const email = cleanText(body.email, 200).toLowerCase();
  const question = cleanBlock(body.question, 2000);
  const priceAccepted = isChecked(body.priceAccepted);

  const db = await getDb();

  const campaigns = await db.query<CampaignRow>(
    `SELECT id, opportunity_id, price_monthly, landing_slug
       FROM campaigns
      WHERE landing_slug = $1
      LIMIT 1`,
    [body.slug],
  );
  const campaign = campaigns.rows[0];
  if (!campaign) return json({ ok: false, error: 'UNKNOWN_CAMPAIGN' }, 404);

  const priceMonthly = toNumber(campaign.price_monthly, 0);

  // Link the commitment to an existing prospect when this company was one of
  // the businesses we actually emailed. `www.` variants are the only spelling
  // difference worth tolerating here.
  const prospects = await db.query<{ id: string }>(
    `SELECT id FROM prospects
      WHERE opportunity_id = $1 AND lower(domain) IN ($2, $3)
      ORDER BY created_at ASC
      LIMIT 1`,
    [campaign.opportunity_id, companyKey, `www.${companyKey}`],
  );
  const prospectId = prospects.rows[0]?.id ?? null;

  const evidenceText = [
    `Landing form submission on /v/${campaign.landing_slug}.`,
    `Submitted email: ${email}.`,
    `Submitted website: ${cleanText(body.domain, 400)} (normalized: ${companyKey}).`,
    `Price checkbox "${formatPrice(priceMonthly)}/month when available": ${
      priceAccepted ? 'CHECKED' : 'not checked'
    }.`,
    question ? `Workflow note: ${question}` : 'Workflow note: (none supplied).',
  ].join(' ');

  const evidenceUrl = `${getConfig().publicBaseUrl}/v/${campaign.landing_slug}`;

  const types: Array<'PILOT_SIGNUP' | 'EXPLICIT_PRICE_ACCEPTANCE'> = ['PILOT_SIGNUP'];
  if (priceAccepted) types.push('EXPLICIT_PRICE_ACCEPTANCE');

  let created: string[] = [];
  try {
    created = await db.transaction(async (tx) => {
      const inserted: string[] = [];
      for (const type of types) {
        const res = await tx.query<{ id: string }>(
          `INSERT INTO commitments
             (id, campaign_id, prospect_id, company_key, type, price_monthly, source,
              evidence_text, evidence_url, verified, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,'LANDING_FORM',$7,$8,true,$9)
           ON CONFLICT (dedupe_key) DO NOTHING
           RETURNING id`,
          [
            newId('cmt'),
            campaign.id,
            prospectId,
            companyKey,
            type,
            priceMonthly,
            evidenceText,
            evidenceUrl,
            `${campaign.id}:${companyKey}:${type}`,
          ],
        );
        if (res.rowCount > 0) inserted.push(type);
      }
      return inserted;
    });
  } catch (err) {
    logger.error('pilot signup failed', {
      slug: campaign.landing_slug,
      companyKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ ok: false, error: 'SERVER_ERROR' }, 500);
  }

  logger.info('pilot signup recorded', {
    campaignId: campaign.id,
    companyKey,
    priceAccepted,
    created,
    linkedProspect: prospectId !== null,
  });

  return json(
    {
      ok: true,
      alreadyRecorded: created.length === 0,
      priceAccepted,
      recorded: created,
      companyKey,
    },
    200,
  );
}

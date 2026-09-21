/**
 * Conversation state — one row per (campaign, prospect).
 *
 * The reply agent used to answer every inbound email from a blank slate, so it
 * could greet the same person twice, re-ask a question they already answered,
 * or quote a price it had never quoted them. This is the memory that makes
 * that impossible: what has been asked, what has been answered, which features
 * they wanted, which objections they raised, what price they were quoted, and
 * whether we are waiting on them.
 *
 * Everything here is deterministic. Question detection is regex, the
 * commitment level is a monotonic ladder, and no model writes to this table.
 */
import { getDb, one, toNumber } from '../../lib/db';
import { newId } from '../../lib/hash';
import type { ReplyAnalysis } from '../../lib/contracts';

/** The questions a prospect actually asks, in the order we detect them. */
export const QUESTION_KEYS = [
  'PRICE',
  'TIMELINE',
  'FEATURE',
  'HOW_IT_WORKS',
  'WHO_IS_IT_FOR',
  'TRUST',
] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];

/**
 * A monotonic ladder. It only ever goes up, except for DECLINED which is a
 * one-way exit — somebody who said no has not become "curious" again because a
 * classifier had a good day.
 */
export const COMMITMENT_LEVELS = [
  'NONE',
  'CURIOUS',
  'INTERESTED',
  'PRICE_DISCUSSED',
  'COMMITTED',
] as const;
export type CommitmentLevel = (typeof COMMITMENT_LEVELS)[number] | 'DECLINED';

const QUESTION_PATTERNS: ReadonlyArray<{ key: QuestionKey; pattern: RegExp }> = [
  {
    key: 'PRICE',
    pattern:
      /\b(how much|what('?s| is) the (price|cost|pricing)|pricing|price point|cost per month|monthly (cost|fee|price)|what (would|will) (it|this) cost|per month\??)\b/i,
  },
  {
    key: 'TIMELINE',
    pattern:
      /\b(when (is|will|would|can|does|do you)[^.?!]{0,40}(ready|available|live|launch|ship|out|done|built)|how (soon|long)|what('?s| is) the (timeline|eta)|release date|any (eta|timeline)|timeframe)\b/i,
  },
  {
    key: 'FEATURE',
    pattern:
      /\b(can it |does it |will it |is it able to|do you support|does this support|would it (handle|support|work with)|any support for|is there (a|an) )\b/i,
  },
  {
    key: 'HOW_IT_WORKS',
    pattern: /\b(how does (it|this) work|how would (it|this) work|how do (i|we) (set|install|use)|what does it do)\b/i,
  },
  {
    key: 'WHO_IS_IT_FOR',
    pattern: /\b(who (is (it|this) for|uses (it|this))|is (it|this) for (us|stores|shops|merchants))\b/i,
  },
  {
    key: 'TRUST',
    pattern: /\b(who are you|what company|are you (a )?real|is this (a )?(scam|spam)|how do (i|we) know|any references)\b/i,
  },
];

/** Which questions this inbound message actually asks. Pure function. */
export function detectQuestions(text: string): QuestionKey[] {
  const body = (text ?? '').slice(0, 20_000);
  const found: QuestionKey[] = [];
  for (const { key, pattern } of QUESTION_PATTERNS) {
    if (pattern.test(body) && !found.includes(key)) found.push(key);
  }
  return found;
}

function rank(level: CommitmentLevel): number {
  if (level === 'DECLINED') return -1;
  const index = (COMMITMENT_LEVELS as readonly string[]).indexOf(level);
  return index < 0 ? 0 : index;
}

/** The level this one reply implies, ignoring history. */
export function levelForAnalysis(analysis: ReplyAnalysis): CommitmentLevel {
  switch (analysis.classification) {
    case 'UNSUBSCRIBE':
    case 'NOT_INTERESTED':
      return 'DECLINED';
    case 'PRICE_ACCEPTED':
    case 'WANTS_PILOT':
      return 'COMMITTED';
    case 'INTERESTED_STRONG':
    case 'FEATURE_REQUIREMENT':
      return analysis.priceReaction === 'NOT_MENTIONED' ? 'INTERESTED' : 'PRICE_DISCUSSED';
    case 'INTERESTED_WEAK':
    case 'ASKING_QUESTION':
    case 'USING_COMPETITOR':
      return analysis.priceReaction === 'NOT_MENTIONED' ? 'CURIOUS' : 'PRICE_DISCUSSED';
    default:
      return 'NONE';
  }
}

/** Monotonic merge. DECLINED wins over everything and is never undone. */
export function mergeLevel(current: CommitmentLevel, incoming: CommitmentLevel): CommitmentLevel {
  if (current === 'DECLINED' || incoming === 'DECLINED') return 'DECLINED';
  return rank(incoming) > rank(current) ? incoming : current;
}

export interface ConversationState {
  id: string;
  campaignId: string;
  prospectId: string;
  threadId: string | null;
  commitmentLevel: CommitmentLevel;
  /** Question keys we have already answered. Never answered twice. */
  answered: QuestionKey[];
  /** Question keys they have asked, answered or not. */
  asked: QuestionKey[];
  requestedFeatures: string[];
  objections: string[];
  priceQuoted: number | null;
  awaitingReply: boolean;
}

interface ConversationRow {
  id: string;
  campaign_id: string;
  prospect_id: string;
  thread_id: string | null;
  commitment_level: string;
  answered_json: unknown;
  asked_json: unknown;
  requested_features_json: unknown;
  objections_json: unknown;
  price_quoted: string | number | null;
  awaiting_reply: boolean;
}

const SELECT_CONVERSATION = `SELECT id, campaign_id, prospect_id, thread_id, commitment_level,
       answered_json, asked_json, requested_features_json, objections_json,
       price_quoted, awaiting_reply
  FROM conversations`;

function parseArray(value: unknown): string[] {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toState(row: ConversationRow): ConversationState {
  const price = row.price_quoted === null ? null : toNumber(row.price_quoted);
  return {
    id: row.id,
    campaignId: row.campaign_id,
    prospectId: row.prospect_id,
    threadId: row.thread_id,
    commitmentLevel: (row.commitment_level as CommitmentLevel) ?? 'NONE',
    answered: parseArray(row.answered_json).filter(isQuestionKey),
    asked: parseArray(row.asked_json).filter(isQuestionKey),
    requestedFeatures: parseArray(row.requested_features_json),
    objections: parseArray(row.objections_json),
    priceQuoted: price !== null && Number.isFinite(price) && price > 0 ? price : null,
    awaitingReply: row.awaiting_reply === true,
  };
}

function isQuestionKey(value: string): value is QuestionKey {
  return (QUESTION_KEYS as readonly string[]).includes(value);
}

export async function getConversation(
  campaignId: string,
  prospectId: string,
): Promise<ConversationState | null> {
  const row = await one<ConversationRow>(
    `${SELECT_CONVERSATION} WHERE campaign_id = $1 AND prospect_id = $2`,
    [campaignId, prospectId],
  );
  return row ? toState(row) : null;
}

export async function ensureConversation(params: {
  campaignId: string;
  prospectId: string;
  threadId?: string | null;
}): Promise<ConversationState> {
  const db = await getDb();
  await db.query(
    `INSERT INTO conversations (id, campaign_id, prospect_id, thread_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (campaign_id, prospect_id) DO UPDATE
        SET thread_id  = COALESCE(conversations.thread_id, EXCLUDED.thread_id),
            updated_at = now()`,
    [newId('cv'), params.campaignId, params.prospectId, params.threadId ?? null],
  );
  const state = await getConversation(params.campaignId, params.prospectId);
  if (state) return state;
  // Defensive: the row was just written, so this should be unreachable.
  return {
    id: '',
    campaignId: params.campaignId,
    prospectId: params.prospectId,
    threadId: params.threadId ?? null,
    commitmentLevel: 'NONE',
    answered: [],
    asked: [],
    requestedFeatures: [],
    objections: [],
    priceQuoted: null,
    awaitingReply: false,
  };
}

function union(existing: string[], additions: readonly string[], max = 40): string[] {
  return Array.from(new Set([...existing, ...additions.filter((a) => a.trim() !== '')])).slice(0, max);
}

/**
 * Folds one inbound reply into the conversation. Returns the state AFTER the
 * update, which is what the reply agent then reads.
 */
export async function recordInboundTurn(params: {
  campaignId: string;
  prospectId: string;
  threadId?: string | null;
  text: string;
  analysis: ReplyAnalysis;
  objections?: readonly string[];
}): Promise<ConversationState> {
  const before = await ensureConversation({
    campaignId: params.campaignId,
    prospectId: params.prospectId,
    threadId: params.threadId ?? null,
  });

  const asked = union(before.asked, detectQuestions(params.text));
  const level = mergeLevel(before.commitmentLevel, levelForAnalysis(params.analysis));
  const feature = params.analysis.requestedFeature?.trim() ?? '';
  const features = feature === '' ? before.requestedFeatures : union(before.requestedFeatures, [feature.slice(0, 200)]);
  const objections = union(before.objections, params.objections ?? []);

  const db = await getDb();
  await db.query(
    `UPDATE conversations
        SET asked_json              = $3,
            commitment_level        = $4,
            requested_features_json = $5,
            objections_json         = $6,
            awaiting_reply          = false,
            last_inbound_at         = now(),
            updated_at              = now()
      WHERE campaign_id = $1 AND prospect_id = $2`,
    [
      params.campaignId,
      params.prospectId,
      JSON.stringify(asked),
      level,
      JSON.stringify(features),
      JSON.stringify(objections),
    ],
  );

  return (await getConversation(params.campaignId, params.prospectId)) ?? before;
}

/**
 * Folds one outbound message in: which questions it answered, what price it
 * quoted, and the fact that the ball is now in their court.
 */
export async function recordOutboundTurn(params: {
  campaignId: string;
  prospectId: string;
  answered?: readonly QuestionKey[];
  priceQuoted?: number | null;
  requestedFeatures?: readonly string[];
  awaitingReply?: boolean;
}): Promise<void> {
  const before = await ensureConversation({
    campaignId: params.campaignId,
    prospectId: params.prospectId,
  });
  const answered = union(before.answered, params.answered ?? []);
  const features = union(before.requestedFeatures, params.requestedFeatures ?? []);
  const price = params.priceQuoted ?? before.priceQuoted;

  const db = await getDb();
  await db.query(
    `UPDATE conversations
        SET answered_json           = $3,
            requested_features_json = $4,
            price_quoted            = $5,
            awaiting_reply          = $6,
            last_outbound_at        = now(),
            updated_at              = now()
      WHERE campaign_id = $1 AND prospect_id = $2`,
    [
      params.campaignId,
      params.prospectId,
      JSON.stringify(answered),
      JSON.stringify(features),
      price,
      params.awaitingReply ?? true,
    ],
  );
}

/** Used when a real commitment row lands: the ladder jumps to the top. */
export async function setCommitmentLevel(
  campaignId: string,
  prospectId: string,
  level: CommitmentLevel,
): Promise<void> {
  const before = await ensureConversation({ campaignId, prospectId });
  const merged = mergeLevel(before.commitmentLevel, level);
  if (merged === before.commitmentLevel) return;
  const db = await getDb();
  await db.query(
    `UPDATE conversations SET commitment_level = $3, updated_at = now()
      WHERE campaign_id = $1 AND prospect_id = $2`,
    [campaignId, prospectId, merged],
  );
}

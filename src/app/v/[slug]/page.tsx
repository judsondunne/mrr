/**
 * Public pilot landing page — the one page real prospects see.
 *
 * Server component. Loads the campaign by `landing_slug`, renders the stored
 * copy, and records the visit on a best-effort basis that can never break
 * rendering.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import LandingContent from '@/components/LandingContent';
import { loadLandingView, recordLandingVisit } from '@/app/_lib/landing';
import { cleanText } from '@/app/_lib/text';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const view = await loadLandingView(slug).catch(() => null);
  if (!view) return { title: 'Not found', robots: { index: false, follow: false } };
  return {
    title: `${view.copy.productName} — pilot (being validated)`,
    description: view.copy.oneSentenceOutcome || undefined,
    robots: { index: false, follow: false },
  };
}

export default async function LandingPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const view = await loadLandingView(slug);
  if (!view) notFound();

  const query = await searchParams;
  const referrer = cleanText(first(query.ref), 500);
  const prospectId = cleanText(first(query.p), 64);

  // Best effort. A logging failure must never cost a prospect the page.
  await recordLandingVisit({
    campaignId: view.campaignId,
    opportunityId: view.opportunityId,
    slug: view.slug,
    referrer: referrer || null,
    prospectId: prospectId || null,
  });

  return <LandingContent view={view} />;
}

/**
 * Where a build spec is allowed to be written.
 *
 * The slug is derived, sanitized and then re-checked against its own root:
 * nothing user- or model-supplied can escape the output directory, and there is
 * no code path that writes outside it.
 */
import path from 'node:path';
import { slugify } from '../../lib/hash.js';
import { SafetyError } from '../../lib/errors.js';

export const DEFAULT_OUTPUT_DIR = 'validated';

/** Tests point this at a temp dir; production leaves it unset. */
export function outputRoot(): string {
  const configured = (process.env.VALIDATED_OUTPUT_DIR ?? '').trim();
  return path.resolve(process.cwd(), configured === '' ? DEFAULT_OUTPUT_DIR : configured);
}

export function safeSlug(candidate: string, fallback: string): string {
  const slug = slugify(candidate);
  if (slug.length > 0) return slug;
  const fallbackSlug = slugify(fallback);
  if (fallbackSlug.length > 0) return fallbackSlug;
  throw new SafetyError('cannot derive a safe directory name for this build spec', { candidate });
}

export interface SpecLocation {
  slug: string;
  root: string;
  directory: string;
}

export function resolveSpecLocation(candidate: string, fallback: string): SpecLocation {
  const slug = safeSlug(candidate, fallback);
  const root = outputRoot();
  const directory = path.resolve(root, slug);

  // Belt and braces: slugify already removed separators and dots.
  if (directory !== path.join(root, slug) || !directory.startsWith(root + path.sep)) {
    throw new SafetyError('refusing to write a build spec outside the output directory', {
      slug,
      root,
      directory,
    });
  }
  return { slug, root, directory };
}

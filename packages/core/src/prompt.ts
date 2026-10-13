/**
 * Prompt loading and version identity.
 *
 * A prompt version is `<name>@<content-hash>`. The hash means an edited prompt
 * cannot masquerade as the version whose metrics are already recorded — the eval
 * report and the analysis_runs row will disagree with the previous ones, visibly.
 *
 * `loadPromptFrom` is general over a directory so the Spec Compiler's prompts get the
 * same version identity and caching as the Phase 1 prompts, rather than a second copy
 * of this logic that could drift. The default `loadPrompt` resolves core's own
 * `prompts/` directory.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promptContentHash } from '@specfix/shared';

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

const SYSTEM_MARKER = '--- SYSTEM ---';

export interface LoadedPrompt {
  name: string;
  /** e.g. "single-shot-v1@a3f19c2b4d05" */
  version: string;
  /** Everything after the --- SYSTEM --- marker. */
  systemMessage: string;
}

const cache = new Map<string, LoadedPrompt>();

export async function loadPrompt(name: string): Promise<LoadedPrompt> {
  return loadPromptFrom(promptsDir, name);
}

/**
 * Loads a prompt by name from an explicit directory, caching per (dir, name) so two
 * packages cannot collide on a shared prompt name with different content.
 */
export async function loadPromptFrom(dir: string, name: string): Promise<LoadedPrompt> {
  const cacheKey = `${dir}::${name}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const path = join(dir, `${name}.md`);
  let file: string;
  try {
    file = await readFile(path, 'utf8');
  } catch {
    const available = await listPromptNamesIn(dir);
    throw new Error(
      `Unknown prompt "${name}" in ${dir}. Available: ${available.join(', ') || '(none)'}`
    );
  }

  const markerIndex = file.indexOf(SYSTEM_MARKER);
  if (markerIndex === -1) {
    throw new Error(`Prompt "${name}" is missing its "${SYSTEM_MARKER}" marker.`);
  }

  const systemMessage = file.slice(markerIndex + SYSTEM_MARKER.length).trim();
  if (systemMessage === '') {
    throw new Error(`Prompt "${name}" has an empty system message.`);
  }

  // Hash the whole file, notes included: a comment that changes the intent of the
  // prompt is a change worth a new version number.
  const loaded: LoadedPrompt = {
    name,
    version: `${name}@${promptContentHash(file)}`,
    systemMessage,
  };
  cache.set(cacheKey, loaded);
  return loaded;
}

export async function listPromptNames(): Promise<string[]> {
  return listPromptNamesIn(promptsDir);
}

export async function listPromptNamesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => []);
  return entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

export function clearPromptCache(): void {
  cache.clear();
}

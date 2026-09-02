/**
 * Prompt loading and version identity.
 *
 * A prompt version is `<name>@<content-hash>`. The hash means an edited prompt
 * cannot masquerade as the version whose metrics are already recorded — the eval
 * report and the analysis_runs row will disagree with the previous ones, visibly.
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
  const cached = cache.get(name);
  if (cached) return cached;

  const path = join(promptsDir, `${name}.md`);
  let file: string;
  try {
    file = await readFile(path, 'utf8');
  } catch {
    const available = await listPromptNames();
    throw new Error(`Unknown prompt "${name}". Available: ${available.join(', ') || '(none)'}`);
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
  cache.set(name, loaded);
  return loaded;
}

export async function listPromptNames(): Promise<string[]> {
  const entries = await readdir(promptsDir).catch(() => []);
  return entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

export function clearPromptCache(): void {
  cache.clear();
}

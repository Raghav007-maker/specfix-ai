/**
 * Azure connectivity probe.
 *
 * Checks the three things the analysis passes actually depend on, against the
 * deployments named in .env:
 *
 *   1. a plain chat completion (does the deployment exist and answer)
 *   2. a strict json_schema response_format (the Extractor/Critic passes require it)
 *   3. an embedding call with a dimension count (must be 1536 for the vector(1536) columns)
 *
 * Throwaway diagnostic — exits non-zero if any check fails, so `npm` can gate on it.
 */
import { readFileSync } from 'node:fs';
import { AzureOpenAI } from 'openai';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const { AZURE_OPENAI_ENDPOINT: endpoint, AZURE_OPENAI_API_KEY: apiKey } = env;
const apiVersion = env.AZURE_OPENAI_API_VERSION;
const chatModel = env.OPENAI_MODEL_EXTRACT;
const embedModel = env.OPENAI_MODEL_EMBED;

console.log('endpoint    :', endpoint);
console.log('apiVersion  :', apiVersion);
console.log('key         : present =', Boolean(apiKey), '| length =', (apiKey ?? '').length);
console.log('chat deploy :', chatModel);
console.log('embed deploy:', embedModel);
console.log('');

const client = new AzureOpenAI({ endpoint, apiKey, apiVersion, maxRetries: 0, timeout: 60_000 });
const failures = [];

function fail(label, error) {
  failures.push(label);
  console.log(`[FAIL] ${label}`);
  console.log('       status:', error?.status);
  console.log('       code  :', error?.code);
  console.log('       msg   :', error?.message);
  if (error?.error) console.log('       body  :', JSON.stringify(error.error));
}

// 1 — chat completion
try {
  const t0 = Date.now();
  const res = await client.chat.completions.create({
    model: chatModel,
    messages: [
      { role: 'system', content: 'Reply with exactly the word: pong' },
      { role: 'user', content: 'ping' },
    ],
  });
  console.log(`[ok] chat — deployment="${chatModel}" served="${res.model}"`);
  console.log(`     reply=${JSON.stringify(res.choices[0]?.message?.content)}`);
  console.log(`     usage=${JSON.stringify(res.usage)} latency=${Date.now() - t0}ms`);
} catch (error) {
  fail(`chat (${chatModel})`, error);
}

// 2 — strict structured output, which the Extractor and Critic passes rely on
try {
  const res = await client.chat.completions.create({
    model: chatModel,
    messages: [{ role: 'user', content: 'Return a JSON object with ok set to true.' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'probe',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
  });
  console.log(`[ok] json_schema — ${res.choices[0]?.message?.content}`);
} catch (error) {
  fail(`json_schema (${chatModel})`, error);
}

// 3 — embeddings, and the dimension the pgvector columns are declared with
try {
  const t0 = Date.now();
  const res = await client.embeddings.create({ model: embedModel, input: 'hello world' });
  const dims = res.data[0].embedding.length;
  console.log(`[ok] embed — deployment="${embedModel}" served="${res.model}"`);
  console.log(`     dims=${dims} usage=${JSON.stringify(res.usage)} latency=${Date.now() - t0}ms`);
  if (dims !== 1536) {
    fail(`embed dimensions (${dims} != 1536 required by vector(1536))`, {});
  }
} catch (error) {
  fail(`embed (${embedModel})`, error);
}

console.log('');
if (failures.length) {
  console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('all checks passed');

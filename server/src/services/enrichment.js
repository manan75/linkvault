import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

import { env } from '../config/env.js';
import { MAX_AUTO_TAGS } from '../utils/tags.js';
import { EnrichmentError } from './enrichmentError.js';

/**
 * Summary and tag generation, and the only file in the project that knows a
 * provider exists.
 *
 * That containment is the point. It is what let the provider change from
 * Anthropic to OpenAI while this phase was still being planned without touching
 * anything else, and it is what keeps "revisit a local model at Phase 9" a real
 * option rather than a slogan. Everything above it only ever sees
 * `enrichLink()` and `EnrichmentError`.
 */

/** How many of the user's own tags to show the model. */
export const MAX_VOCABULARY_TAGS = 300;

/**
 * How long one call may take before the SDK aborts it.
 *
 * Deliberately expressed here, as a request option, rather than as a race in
 * the worker. A `Promise.race` leaves the request running and rejects with a
 * plain `Error`, which the queue would then classify as permanent -- a timeout
 * misclassified as unretryable is the exact bug Phase 4 shipped once already.
 * The SDK's own timeout cancels the request and raises
 * `APIConnectionTimeoutError`, which `classify` reads as retryable.
 *
 * Comfortably inside the processing lease in `workers/enrichmentQueue.js`, so a
 * call can never outlive the claim protecting it.
 */
export const CALL_TIMEOUT_MS = 60_000;

/**
 * The SDK retries transient failures itself, and that is worth keeping for a
 * blip mid-request -- but it must stay small. Our own ladder is the durable
 * retry, it survives a process restart, and multiplying the two would turn
 * three attempts into nine calls against a provider that is already unwell.
 */
const SDK_MAX_RETRIES = 1;

// Re-exported so a caller that only wants the error never has to reach past
// this module for it.
export { EnrichmentError };

/**
 * Structured output. Both fields are required and unconstrained on purpose:
 * strict JSON schema mode rejects optionals and ignores array length bounds, so
 * the tag cap is enforced after the call, in `utils/tags.js`, where it holds.
 */
const EnrichmentSchema = z.object({
  summary: z.string(),
  tags: z.array(z.string()),
});

const SYSTEM_PROMPT = [
  'You label saved bookmarks for a personal bookmark manager.',
  'You are given only the page title and description -- never the page itself.',
  '',
  'Summary:',
  '- One or two plain sentences saying what the page is about and who it is for.',
  '- Write it for someone who saved this weeks ago and half remembers it.',
  '- Do not open with "This page" or "This article", and do not repeat the title verbatim.',
  '- If the input does not actually say what the page is about, return an empty string.',
  '  Never guess from the URL, the domain or the title alone. A wrong summary is',
  '  worse than no summary: it is shown to the user as fact.',
  '',
  'Tags:',
  '- Always tag, even when the summary has to be empty. A title alone is usually',
  '  enough to name the subject, and naming a subject is not the same as claiming',
  '  to know what the page says about it.',
  `- At most ${MAX_AUTO_TAGS}, and fewer when fewer are warranted. One is a fine answer;`,
  `  ${MAX_AUTO_TAGS} is a ceiling, not a target. Do not pad the list to reach it.`,
  '- Lowercase and hyphenated.',
  '- A tag exists to gather many bookmarks under one word. Prefer the broadest tag',
  '  that is still accurate: a tag that fits only this one page is a label nobody',
  '  will ever click.',
  '- Never give both a tag and a narrowing of the same tag. "instagram" and',
  '  "instagram-reel" are one tag, not two, and so are "kpop" and "kpop-idol".',
  '  Pick the broader one.',
  '- Do not tag the site or platform the page is hosted on. The domain is already',
  '  stored and already filterable, so "youtube", "instagram" and "github" add',
  '  nothing. Tag what the page is about instead.',
  '- Topics and technologies, not opinions and not the content type.',
  '- Reuse a tag from the existing vocabulary whenever it genuinely fits, including',
  '  when the wording differs: "postgres" and "postgresql" are the same tag, and',
  '  so are "ml" and "machine-learning".',
  '- Do NOT reuse a vocabulary tag that merely sits in the same field. "react" is',
  '  not "vue" and "css" is not "tailwind". Propose a new tag when nothing fits.',
].join('\n');

/**
 * Everything the model is allowed to see about a link.
 *
 * A single function on purpose: §4 of the plan decided against storing page
 * text, and that decision is meant to be cheap to reverse. If summaries prove
 * too thin in use, capturing an excerpt in the metadata worker becomes a change
 * to this function and one schema field -- the worker, the events and the retry
 * logic never learn about it.
 */
export function buildEnrichmentInput(link) {
  return {
    title: (link.title ?? '').trim(),
    description: (link.description ?? '').trim(),
    domain: (link.domain ?? '').trim(),
  };
}

/** A domain, with the noise that stops two spellings of it comparing equal. */
const bareDomain = (value) => value.toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');

/**
 * Whether there is anything worth paying for.
 *
 * A link with no description and no title gives the model nothing at all, and a
 * link whose title is just its own domain gives it nothing but a hostname --
 * the shape every bookmark saved before extraction stopped writing the domain
 * into `title` still carries. Asking anyway costs money and creates the
 * strongest possible temptation to invent. Skipping is the honest answer.
 */
export function hasEnoughToEnrich({ title, description, domain }) {
  if (description) return true;
  if (!title) return false;

  return bareDomain(title) !== bareDomain(domain ?? '');
}

function buildUserPrompt({ title, description }, vocabulary) {
  const lines = [];

  if (vocabulary.length > 0) {
    lines.push(`Existing tags in this user's library: ${vocabulary.join(', ')}`, '');
  }

  lines.push(`Title: ${title || '(none)'}`);
  lines.push(`Description: ${description || '(none)'}`);

  return lines.join('\n');
}

/**
 * Translates an SDK error into the retryable/permanent split the queue needs.
 *
 * Ordered most specific first, because the SDK's error classes are a hierarchy
 * and a single broad `instanceof APIError` would swallow the distinction
 * between "the provider is briefly unwell" and "this request can never
 * succeed". Phase 3's third bug was a timeout misclassified as permanent; not
 * repeating it lives here.
 */
function classify(error) {
  if (error instanceof EnrichmentError) return error;

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new EnrichmentError('The model timed out', { retryable: true });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new EnrichmentError('Could not reach the model', { retryable: true });
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new EnrichmentError('Rate limited by the model', { retryable: true, status: 429 });
  }
  if (error instanceof OpenAI.InternalServerError) {
    return new EnrichmentError('The model is unavailable', {
      retryable: true,
      status: error.status,
    });
  }
  // 400, 401, 403, 404 and anything else carrying a status: retrying an
  // identical request cannot change the answer.
  if (error instanceof OpenAI.APIError) {
    return new EnrichmentError(`The model rejected the request (${error.status})`, {
      status: error.status,
    });
  }

  // A schema-validation failure from `responses.parse`, or a bug in here.
  // Neither gets better on a second attempt.
  return new EnrichmentError(`Enrichment failed: ${error.message}`);
}

let client;

/** Lazily constructed, so importing this module never requires a key. */
function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: SDK_MAX_RETRIES });
  }
  return client;
}

/**
 * `reasoning` is a GPT-5-family parameter and a 4.x model returns 400 for it.
 * `OPENAI_MODEL` is deliberately free-form so the quality run can compare tiers
 * without a rebuild, so the request adapts rather than assuming.
 *
 * Kept at the low end: this is a short, bounded classification job, and raising
 * it bought latency rather than better output.
 */
function reasoningFor(model) {
  return /^gpt-5/.test(model) ? { reasoning: { effort: 'low' } } : {};
}

/**
 * One call: a summary and tags for one bookmark.
 *
 * Returns raw model output. Normalisation, the vocabulary case-snap and the tag
 * cap all happen in `utils/tags.js`, above this, so they hold whether or not
 * the model cooperated.
 *
 * Note the absence of `temperature`. It is not supported on the GPT-5 models,
 * and structured output already removes the reason to reach for it.
 */
export async function enrichLink({
  title,
  description,
  vocabulary = [],
  timeoutMs = CALL_TIMEOUT_MS,
} = {}) {
  try {
    const response = await getClient().responses.parse(
      {
        model: env.OPENAI_MODEL,
        ...reasoningFor(env.OPENAI_MODEL),
        input: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserPrompt(
              { title, description },
              vocabulary.slice(0, MAX_VOCABULARY_TAGS),
            ),
          },
        ],
        text: { format: zodTextFormat(EnrichmentSchema, 'enrichment') },
      },
      { timeout: timeoutMs },
    );

    const parsed = response.output_parsed;

    // A refusal, or a response cut off by the output limit, parses to nothing.
    // Permanent: the same request would produce the same non-answer.
    if (!parsed) throw new EnrichmentError('The model returned no usable output');

    return {
      summary: parsed.summary.trim(),
      tags: parsed.tags,
      usage: response.usage,
    };
  } catch (error) {
    throw classify(error);
  }
}

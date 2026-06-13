import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ── Environment ────────────────────────────────────────────────────────────

function getAPIKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

function getBaseURL(): string | undefined {
  return process.env.OPENAI_BASE_URL?.trim() || undefined;
}

function getModel(): string {
  return process.env.AI_MODEL?.trim() || "deepseek-v4-flash";
}

// ── Public helpers ─────────────────────────────────────────────────────────

export function hasAI(): boolean {
  return Boolean(getAPIKey());
}

export function getAIModel(): string {
  return getModel();
}

// ── Prompt sanitization ────────────────────────────────────────────────────

/**
 * Sanitize a user-supplied value before injecting it into an AI prompt.
 * Mitigates prompt injection by stripping delimiters and truncating.
 *
 * This is defense-in-depth — it raises the bar but is not a guarantee.
 * System prompts are server-authored constants, never user-supplied.
 */
export function sanitizePromptField(value: unknown, maxLength = 200): string {
  let s = String(value ?? "");

  // Strip markdown code fences and blockquote markers
  s = s.replace(/```/g, "");
  s = s.replace(/"""/g, "");
  s = s.replace(/^[ \t]*[#>]+[ \t]*/gm, "");

  // Strip control characters (keep common whitespace and printable Unicode)
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

  // Collapse multiple consecutive newlines
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.slice(0, maxLength).trim();
}

// ── Client singleton ───────────────────────────────────────────────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!hasAI()) return null;
  if (!_client) {
    _client = new OpenAI({
      apiKey: getAPIKey(),
      baseURL: getBaseURL(),
      timeout: 30_000,
      maxRetries: 1,
    });
  }
  return _client;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChatCompletionOptions {
  /** Zod schema name for structured output (sent as instructions to the model). */
  schemaDescription?: string;
  /** Override default timeout (ms). */
  timeout?: number;
  /** Temperature override (default 0.7). */
  temperature?: number;
  /** Maximum tokens override. */
  maxTokens?: number;
}

// ── Chat completion ────────────────────────────────────────────────────────

/**
 * Send a single-turn chat completion request.
 * Returns `null` when no API key is configured (caller should fall back).
 * Throws on network errors after exhausting retries.
 */
export async function chatCompletion(
  systemPrompt: string,
  userPrompt: string,
  options: ChatCompletionOptions = {},
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  try {
    const completion = await client.chat.completions.create(
      {
        model: getModel(),
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 2000,
      },
      { timeout: options.timeout ?? 30_000 },
    );

    return completion.choices[0]?.message?.content?.trim() ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ai-client] chat completion failed: ${message}`);
    throw error;
  }
}

/**
 * Same as `chatCompletion` but parses the response as JSON matching the given
 * schema.  Falls back to `null` when the model returns unparseable output.
 */
export async function chatCompletionJSON<T>(
  systemPrompt: string,
  userPrompt: string,
  options: ChatCompletionOptions = {},
): Promise<T | null> {
  const client = getClient();
  if (!client) return null;

  // Append JSON instruction to system prompt
  const jsonHint = options.schemaDescription
    ? `\n\nIMPORTANT: Respond ONLY with valid JSON matching this schema: ${options.schemaDescription}. Do not include markdown fences or extra text.`
    : "\n\nIMPORTANT: Respond ONLY with valid JSON. Do not include markdown fences or extra text.";

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt + jsonHint },
    { role: "user", content: userPrompt },
  ];

  try {
    const completion = await client.chat.completions.create(
      {
        model: getModel(),
        messages,
        temperature: options.temperature ?? 0.4,
        max_tokens: options.maxTokens ?? 2000,
        response_format: { type: "json_object" },
      },
      { timeout: options.timeout ?? 30_000 },
    );

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ai-client] JSON completion failed: ${message}`);
    throw error;
  }
}

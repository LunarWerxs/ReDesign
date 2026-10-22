// All provider plumbing in one place: error handling + HTTP, the three API
// adapters (Anthropic, OpenAI-compatible, Gemini), a mock adapter for offline
// runs, and the registry that maps a model to its adapter.

import { CLASS, type ErrorClass } from "./keyManager";
import { redactSecrets, sleep, type ImagePayload } from "./util";
import type { Model } from "./config/models";
import { OPENAI_FAMILY } from "./config/shared";
import { providerCall } from "./provider-call";

// ---------------------------------------------------------------------------
// Errors + HTTP
// ---------------------------------------------------------------------------
interface ProviderErrorOptions {
  errorClass?: ErrorClass;
  status?: number | null;
  retryAfterMs?: number | null;
  providerMessage?: string | null;
  providerCode?: string | null;
  providerType?: string | null;
  usage?: unknown;
  finishReason?: string | null;
}

class ProviderError extends Error {
  errorClass: ErrorClass;
  status: number | null;
  retryAfterMs: number | null;
  providerMessage: string;
  providerCode: string | null;
  providerType: string | null;
  usage: unknown;
  finishReason: string | null;

  constructor(message: string, { errorClass = CLASS.UNKNOWN, status = null, retryAfterMs = null, providerMessage = null, providerCode = null, providerType = null, usage = null, finishReason = null }: ProviderErrorOptions = {}) {
    super(message);
    this.name = "ProviderError";
    this.errorClass = errorClass;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.providerMessage = providerMessage || message;
    this.providerCode = providerCode;
    this.providerType = providerType;
    this.usage = usage;
    this.finishReason = finishReason;
  }
  // A different key cannot fix malformed/content-blocked requests or an operation's
  // resource permission, so neither class should rotate through the key pool.
  get retryable(): boolean {
    return this.errorClass !== CLASS.BAD_REQUEST && this.errorClass !== CLASS.PERMISSION;
  }
}

function parseRetryAfter(headers: Headers | null | undefined): number | null {
  if (!headers || typeof headers.get !== "function") return null;
  const ra = headers.get("retry-after");
  if (!ra) return null;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(ra);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

// A 400/403 sometimes carries an ACCOUNT/BILLING failure rather than a malformed
// request, e.g. DashScope (Qwen) answers an out-of-credit key with
//   HTTP 400 {"type":"Arrearage","message":"Access denied, please make sure your
//   account is in good standing ... overdue-payment"}
// Those are KEY-SPECIFIC: a different key in the pool succeeds. They must map to
// NO_BALANCE / AUTH, which the runner retries across keys AND which cool the bad
// key, never to BAD_REQUEST, the one class the runner won't retry (reserved for a
// genuinely malformed / content-blocked request that every key would share).
const BALANCE_HINTS = [
  "insufficient balance", "no balance", "insufficient_quota", "insufficient quota",
  "exceeded your current quota", "billing", "arrearage", "overdue", "good standing",
  "payment required", "out of credit", "not enough balance",
];
const ACCOUNT_DEAD_HINTS = [
  "api key", "invalid key", "api_key", "incorrect api key", "invalid_api_key",
  "suspend", "deactivat", "account disabled", "key disabled", "expired", "revoked",
];
const INVALID_CREDENTIAL_HINTS = [
  "invalid api key", "api key is invalid", "api key not valid", "incorrect api key", "invalid_api_key",
  "api key has been revoked", "key has been revoked", "api key revoked", "key revoked",
];
const INVALID_CREDENTIAL_TYPES = new Set(["invalid_api_key", "api_key_invalid", "authentication_error"]);

interface Classification {
  errorClass: ErrorClass;
  retryAfterMs: number | null;
  providerCode: string | null;
  providerType: string | null;
}

function providerDetails(bodyText: string | null | undefined): Pick<Classification, "providerCode" | "providerType"> {
  try {
    const parsed = JSON.parse(bodyText || "") as { code?: unknown; type?: unknown; error?: { code?: unknown; type?: unknown } };
    const error = parsed && typeof parsed === "object" ? parsed.error : null;
    const pick = (value: unknown) => typeof value === "string" ? value : null;
    return { providerCode: pick(error?.code) || pick(parsed.code), providerType: pick(error?.type) || pick(parsed.type) };
  } catch {
    return { providerCode: null, providerType: null };
  }
}

type ProviderDetails = Pick<Classification, "providerCode" | "providerType">;

function mentionsIn(body: string, ...words: string[]): boolean {
  return words.some((w) => body.includes(w));
}

// Statuses whose class is fixed by the code alone, with no body inspection.
function fixedStatusClass(status: number): ErrorClass | null {
  if (status === 401) return CLASS.AUTH;
  if (status === 402) return CLASS.NO_BALANCE;
  if (status === 404) return CLASS.BAD_REQUEST; // model not found etc.
  if (status === 529) return CLASS.RATE_LIMIT; // anthropic overloaded
  return null;
}

function looksLikeInvalidCredential(body: string, details: ProviderDetails): boolean {
  if (mentionsIn(body, ...INVALID_CREDENTIAL_HINTS)) return true;
  const type = (details.providerType || "").toLowerCase();
  const code = (details.providerCode || "").toLowerCase();
  return INVALID_CREDENTIAL_TYPES.has(type) || INVALID_CREDENTIAL_TYPES.has(code);
}

// Providers use 403 for model/resource entitlement failures. Those can vary
// by key and model, but do not prove the credential is invalid. Keep AUTH
// for explicit invalid/revoked-key evidence only.
function forbiddenClass(body: string, details: ProviderDetails): ErrorClass {
  if (mentionsIn(body, "quota", "exceeded", "exhausted", ...BALANCE_HINTS)) return CLASS.NO_BALANCE;
  if (looksLikeInvalidCredential(body, details)) return CLASS.AUTH;
  return CLASS.PERMISSION;
}

// Daily/credit exhaustion -> long cooldown. Generic 429 (per-minute rate)
// stays RATE_LIMIT so a still-good key isn't benched for an hour.
function rateLimitClass(body: string): ErrorClass {
  if (mentionsIn(body, ...BALANCE_HINTS)) return CLASS.NO_BALANCE;
  return CLASS.RATE_LIMIT;
}

// Account/billing failures dressed up as a 400 are key-specific → retry elsewhere.
function badRequestClass(body: string): ErrorClass {
  if (mentionsIn(body, ...BALANCE_HINTS)) return CLASS.NO_BALANCE;
  if (mentionsIn(body, ...ACCOUNT_DEAD_HINTS)) return CLASS.AUTH;
  return CLASS.BAD_REQUEST;
}

function classifyStatus(status: number, body: string, details: ProviderDetails): ErrorClass {
  const fixed = fixedStatusClass(status);
  if (fixed !== null) return fixed;
  if (status === 403) return forbiddenClass(body, details);
  if (status === 429) return rateLimitClass(body);
  if (status === 400) return badRequestClass(body);
  if (status >= 500) return CLASS.SERVER;
  return CLASS.UNKNOWN;
}

// Map an HTTP response (status + headers + body text) to a key-manager class.
function classifyHttp(status: number, headers: Headers | null | undefined, bodyText: string | null | undefined): Classification {
  const body = (bodyText || "").toLowerCase();
  const retryAfterMs = parseRetryAfter(headers);
  const details = providerDetails(bodyText);
  const errorClass = classifyStatus(status, body, details);
  return { errorClass, retryAfterMs, ...details };
}

// A transport failure under the shared abort scope: an external cancellation
// wins over the timeout, which wins over the underlying error's own message.
// `phase` names the timed-out step ("request" / "body read") and `errLabel` is
// the prefix of the message for a failure that was neither.
function networkFailure(err: unknown, phase: string, errLabel: string, timeoutMs: number | null | undefined, ctrl: AbortController, externalSignal: AbortSignal | null | undefined): ProviderError {
  if (externalSignal?.aborted) return new ProviderError("cancelled", { errorClass: CLASS.NETWORK });
  if (ctrl.signal.aborted) return new ProviderError(`${phase} timed out after ${timeoutMs}ms`, { errorClass: CLASS.NETWORK });
  return new ProviderError(`${errLabel}${(err as Error).message}`, { errorClass: CLASS.NETWORK });
}

async function fetchResponse(url: string, options: RequestInit, ctrl: AbortController, timeoutMs: number | null | undefined, externalSignal: AbortSignal | null | undefined): Promise<Response> {
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    throw networkFailure(err, "request", "network error: ", timeoutMs, ctrl, externalSignal);
  }
}

async function readResponseBody(res: Response, ctrl: AbortController, timeoutMs: number | null | undefined, externalSignal: AbortSignal | null | undefined): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw networkFailure(err, "body read", "network error reading body: ", timeoutMs, ctrl, externalSignal);
  }
}

// Non-2xx: classify for the key manager, then report a redacted snippet of the
// provider's own words. classifyHttp runs before redaction, as it always has.
function httpStatusError(res: Response, text: string): ProviderError {
  const { errorClass, retryAfterMs, providerCode, providerType } = classifyHttp(res.status, res.headers, text);
  const snippet = redactSecrets(text.replace(/\s+/g, " ").slice(0, 300));
  return new ProviderError(`HTTP ${res.status}: ${snippet || res.statusText}`, { errorClass, status: res.status, retryAfterMs, providerMessage: snippet, providerCode, providerType });
}

function parseJSONBody<T>(text: string, status: number): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ProviderError(`invalid JSON from provider: ${(err as Error).message}`, { errorClass: CLASS.SERVER, status });
  }
}

/**
 * Single entry point used by every adapter: performs the request AND reads the
 * full response body under ONE timeout/abort scope, then returns parsed JSON.
 * Keeping the timer armed through the body read prevents a provider that sends
 * headers then stalls the stream from hanging a job forever.
 */
async function requestJSON<T = unknown>(url: string, options: RequestInit, timeoutMs: number | null | undefined, externalSignal: AbortSignal | null | undefined): Promise<T> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 120000);
  try {
    const res = await fetchResponse(url, options, ctrl, timeoutMs, externalSignal);
    const text = await readResponseBody(res, ctrl, timeoutMs, externalSignal);
    if (!res.ok) throw httpStatusError(res, text);
    return parseJSONBody<T>(text, res.status);
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Adapters. Each: async call(req) -> { text, usage, finishReason, raw }.
// req = { model, apiKey, systemContract, userPrompt, images[], timeoutMs, signal }
// ---------------------------------------------------------------------------
interface ProviderRequest {
  model: Model;
  apiKey: string;
  systemContract: string;
  userPrompt: string;
  images?: ImagePayload[];
  timeoutMs?: number;
  signal?: AbortSignal | null;
  promptLabel?: string;
  inputName?: string;
}

interface ProviderResult {
  text: string;
  usage: unknown;
  finishReason: string | null | undefined;
  raw: unknown;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: unknown;
}

// Anthropic Messages API (Claude). Vision via base64 image blocks.
async function anthropicCall(req: ProviderRequest): Promise<ProviderResult> {
  const { model, apiKey, systemContract, userPrompt, images = [], timeoutMs, signal } = req;
  const content: unknown[] = [];
  for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
  content.push({ type: "text", text: userPrompt });

  const body: Record<string, unknown> = { model: model.apiModel, max_tokens: model.maxTokens || 8000, system: systemContract, messages: [{ role: "user", content }] };
  if (model.supportsTemperature && model.temperature != null) body.temperature = model.temperature;

  const data = await requestJSON<AnthropicResponse>(
    `${model.baseUrl.replace(/\/$/, "")}/messages`,
    { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) },
    timeoutMs,
    signal
  );
  const text = Array.isArray(data.content) ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
  if (!text.trim()) throw new ProviderError(`empty response (stop_reason=${data.stop_reason})`, { errorClass: CLASS.BAD_REQUEST, usage: data.usage || null, finishReason: data.stop_reason || null });
  return { text, usage: data.usage || null, finishReason: data.stop_reason || null, raw: data };
}

// OpenAI-compatible Chat Completions. Powers GPT 5.5, DeepSeek, Qwen.
// Quirks from models.json: tokenParam (max_tokens vs max_completion_tokens),
// supportsTemperature.
interface OpenAIMessagePart {
  text?: string;
}

interface OpenAIChoice {
  message?: {
    content?: string | OpenAIMessagePart[];
  };
  finish_reason?: string;
}

interface OpenAIChatResponse {
  choices?: OpenAIChoice[];
  usage?: unknown;
}

async function openaiCall(req: ProviderRequest): Promise<ProviderResult> {
  const { model, apiKey, systemContract, userPrompt, images = [], timeoutMs, signal } = req;
  let userContent: unknown;
  if (images.length) {
    userContent = [
      { type: "text", text: userPrompt },
      ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } })),
    ];
  } else {
    userContent = userPrompt;
  }

  const body: Record<string, unknown> = { model: model.apiModel, messages: [{ role: "system", content: systemContract }, { role: "user", content: userContent }] };
  body[model.tokenParam || "max_tokens"] = model.maxTokens || 8000;
  if (model.supportsTemperature && model.temperature != null) body.temperature = model.temperature;

  const data = await requestJSON<OpenAIChatResponse>(
    `${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
    { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) },
    timeoutMs,
    signal
  );
  const choice = data.choices?.[0];
  const msg = choice?.message;
  let text = "";
  if (msg) {
    if (typeof msg.content === "string") text = msg.content;
    else if (Array.isArray(msg.content)) text = msg.content.map((p) => p.text || "").join("");
  }
  if (!text.trim()) throw new ProviderError(`empty response (finish_reason=${choice?.finish_reason})`, { errorClass: CLASS.BAD_REQUEST, usage: data.usage || null, finishReason: choice?.finish_reason || null });
  return { text, usage: data.usage || null, finishReason: choice?.finish_reason, raw: data };
}

interface GeminiPart {
  text?: string;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: GeminiCandidate[];
  usageMetadata?: unknown;
}

interface GeminiRequestBody {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ role: string; parts: unknown[] }>;
  generationConfig: { maxOutputTokens: number; temperature?: number };
}

// Google Generative Language API (Gemini). Vision via inline_data parts.
async function geminiCall(req: ProviderRequest): Promise<ProviderResult> {
  const { model, apiKey, systemContract, userPrompt, images = [], timeoutMs, signal } = req;
  const parts: unknown[] = [{ text: userPrompt }];
  for (const img of images) parts.push({ inline_data: { mime_type: img.mime, data: img.data } });

  const body: GeminiRequestBody = { systemInstruction: { parts: [{ text: systemContract }] }, contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: model.maxTokens || 8000 } };
  if (model.supportsTemperature && model.temperature != null) body.generationConfig.temperature = model.temperature;

  const data = await requestJSON<GeminiResponse>(
    `${model.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model.apiModel)}:generateContent`,
    { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify(body) },
    timeoutMs,
    signal
  );
  if (data.promptFeedback?.blockReason) throw new ProviderError(`blocked: ${data.promptFeedback.blockReason}`, { errorClass: CLASS.BAD_REQUEST, usage: data.usageMetadata || null });
  const cand = data.candidates?.[0];
  const text = cand?.content && Array.isArray(cand.content.parts) ? cand.content.parts.map((p) => p.text || "").join("") : "";
  if (!text.trim()) {
    const reason = cand ? cand.finishReason : "no_candidates";
    const hint = reason === "MAX_TOKENS" ? ", raise maxTokens in models.json" : "";
    throw new ProviderError(`empty response (finishReason=${reason})${hint}`, { errorClass: CLASS.BAD_REQUEST, usage: data.usageMetadata || null, finishReason: cand?.finishReason || null });
  }
  return { text, usage: data.usageMetadata || null, finishReason: cand?.finishReason, raw: data };
}

// Offline stand-in: returns a valid self-contained HTML doc so the whole
// pipeline can run without spending quota. Enable with --mock / MOCK=1.
// Fault injection for tests: MOCK_BAD_SUBSTR, MOCK_FAIL_RATE, MOCK_FAIL_CLASS.
async function mockCall(req: ProviderRequest): Promise<ProviderResult> {
  const { model, userPrompt, images = [], promptLabel = "Custom", inputName = "input" } = req;
  await sleep(20 + Math.floor((model.maxTokens || 0) % 30));

  const badSubstr = process.env.MOCK_BAD_SUBSTR;
  if (badSubstr && req.apiKey && String(req.apiKey).includes(badSubstr)) {
    const cls = (process.env.MOCK_FAIL_CLASS as ErrorClass) || CLASS.RATE_LIMIT;
    throw new ProviderError(`[mock] key matched MOCK_BAD_SUBSTR → ${cls}`, { errorClass: cls, status: 429 });
  }
  const failRate = parseFloat(process.env.MOCK_FAIL_RATE || "0");
  if (failRate > 0) {
    const seed = `${model.id}|${inputName}|${promptLabel}|${req.apiKey || ""}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    if ((h % 1000) / 1000 < failRate) {
      const cls = (process.env.MOCK_FAIL_CLASS as ErrorClass) || CLASS.RATE_LIMIT;
      throw new ProviderError(`[mock] injected ${cls} failure`, { errorClass: cls, status: 429 });
    }
  }

  const esc = (s: unknown) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
  const text = `<!-- REIMAGINE: mock output from ${model.label} (${promptLabel}) -->
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.label)}, ${esc(promptLabel)}</title>
<style>
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaf0;display:grid;place-items:center;min-height:100vh;padding:32px}
  .card{max-width:560px;width:100%;background:#171a21;border:1px solid #262b36;border-radius:18px;padding:28px;box-shadow:0 24px 60px -30px ${model.color || "#000"}}
  h1{margin:0 0 4px;font-size:20px}
  .badge{display:inline-block;font-size:12px;padding:3px 10px;border-radius:999px;background:${model.color || "#3a3f4b"}22;color:${model.color || "#aab"};border:1px solid ${model.color || "#3a3f4b"}55}
  p{color:#aab2c0}.meta{margin-top:18px;font-size:13px;color:#7c8597;border-top:1px solid #262b36;padding-top:14px}
  code{background:#0f1115;padding:2px 6px;border-radius:6px;color:#cdd}
</style></head>
<body><div class="card">
  <span class="badge">MOCK · ${esc(model.id)}</span>
  <h1>Reimagined: ${esc(inputName)}</h1>
  <p>Placeholder render produced in <strong>mock mode</strong> (no API call). Prompt preset: <code>${esc(promptLabel)}</code>.</p>
  <div class="meta">images received: ${images.length} · token budget: ${model.maxTokens || 0}<br>prompt: ${esc(userPrompt.slice(0, 140))}${userPrompt.length > 140 ? "..." : ""}</div>
</div></body></html>`;

  return { text, usage: { mock: true, input_tokens: 0, output_tokens: text.length }, finishReason: "stop", raw: { mock: true } };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
interface Adapter {
  call: (req: ProviderRequest) => Promise<ProviderResult>;
}

const openaiAdapter: Adapter = { call: openaiCall };
const ADAPTERS: Record<string, Adapter> = {
  anthropic: { call: anthropicCall },
  gemini: { call: geminiCall },
  google: { call: geminiCall },
};
// OpenAI, DeepSeek, Qwen, xAI, OpenRouter, Groq, Mistral, Moonshot and Meta AI
// (Muse Spark) all speak the same chat-completions shape, so they share one
// adapter (see OPENAI_FAMILY).
for (const provider of OPENAI_FAMILY) ADAPTERS[provider] = openaiAdapter;
const MOCK: Adapter = { call: mockCall };

function getAdapter(model: Model, { mock = false }: { mock?: boolean } = {}): Adapter {
  const adapter = mock ? MOCK : ADAPTERS[model.provider];
  if (!adapter) throw new Error(`No adapter for provider "${model.provider}" (model ${model.id})`);
  return {
    call: (req) => providerCall({
      pool: model.keyEnv,
      apiKey: req.apiKey,
      modelId: model.id,
      provider: model.provider,
      apiModel: model.apiModel,
      promptLabel: req.promptLabel,
      signal: req.signal,
    }, () => adapter.call(req)),
  };
}

export { ProviderError, classifyHttp, parseRetryAfter, requestJSON, getAdapter, ADAPTERS };
export type { ProviderRequest, ProviderResult, Adapter, Classification };

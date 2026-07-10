// Mocked-fetch tests for src/modelCatalog.ts: per-provider response-shape
// normalization (Anthropic data[], OpenAI-style data[], Gemini models[]),
// the models.dev fallback, cache behavior, and the no-key -> catalog path.
// NO network, global.fetch is replaced with a fixture-driven stub for the
// whole file and restored after.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getAvailableModels, _resetCacheForTests } from "../src/modelCatalog";

const realFetch = global.fetch;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok !== false;
  const status = init?.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(impl: FetchImpl) {
  global.fetch = impl as unknown as typeof fetch;
}

beforeEach(() => {
  // ensure no provider key envs leak between tests
  delete process.env.__TEST_CATALOG_KEY__;
  // each test's fetch mock returns a different fixture, so the module-level
  // caches (both the per-key cache and the shared models.dev blob cache) must
  // not leak results from one test into the next.
  _resetCacheForTests();
});

afterEach(() => {
  global.fetch = realFetch;
});

describe("modelCatalog: provider response normalization", () => {
  it("Anthropic data[] shape -> provider source, excludes obviously-irrelevant ids", async () => {
    process.env.__CATALOG_ANTHROPIC_KEYS__ = "sk-ant-test-key";
    installFetch(async (url) => {
      expect(url).toContain("/models?limit=1000");
      return jsonResponse({
        data: [
          { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
          { id: "claude-haiku-4", display_name: "Claude Haiku 4" },
        ],
      });
    });
    const result = await getAvailableModels({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      keyEnv: "__CATALOG_ANTHROPIC_KEYS__",
    });
    expect(result.source).toBe("provider");
    expect(result.models.map((m) => m.id).sort()).toEqual(["claude-haiku-4", "claude-opus-4-8"]);
    expect(result.models.every((m) => m.source === "provider")).toBe(true);
  });

  it("OpenAI-style data[] shape -> provider source", async () => {
    process.env.__CATALOG_OPENAI_KEYS__ = "sk-proj-test-key";
    installFetch(async (url, init) => {
      expect(url).toContain("/models");
      expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer sk-proj-test-key");
      return jsonResponse({
        data: [{ id: "gpt-5.5" }, { id: "whisper-1" }, { id: "text-embedding-3-large" }],
      });
    });
    const result = await getAvailableModels({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      keyEnv: "__CATALOG_OPENAI_KEYS__",
    });
    expect(result.source).toBe("provider");
    // whisper/embedding excluded by the pragmatic exclude-pattern list
    expect(result.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
  });

  it("Gemini models[] shape -> provider source, strips 'models/' prefix, filters by supportedGenerationMethods", async () => {
    process.env.__CATALOG_GEMINI_KEYS__ = "AIza-test-key";
    installFetch(async (url) => {
      expect(url).toContain("generativelanguage.googleapis.com");
      expect(url).toContain("key=AIza-test-key");
      return jsonResponse({
        models: [
          { name: "models/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", displayName: "Embedding 001", supportedGenerationMethods: ["embedContent"] },
        ],
      });
    });
    const result = await getAvailableModels({
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      keyEnv: "__CATALOG_GEMINI_KEYS__",
    });
    expect(result.source).toBe("provider");
    expect(result.models).toEqual([{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", source: "provider" }]);
  });
});

describe("modelCatalog: no-key -> models.dev catalog fallback", () => {
  it("falls back to models.dev when no key is stored for the provider", async () => {
    installFetch(async (url) => {
      expect(url).toBe("https://models.dev/api.json");
      return jsonResponse({
        anthropic: {
          models: {
            "claude-opus-4-8": { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
          },
        },
      });
    });
    const result = await getAvailableModels({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      keyEnv: "__NO_SUCH_KEY_ENV__",
    });
    expect(result.source).toBe("catalog");
    expect(result.models).toEqual([{ id: "claude-opus-4-8", label: "Claude Opus 4.8", source: "catalog" }]);
  });

  it("falls back to models.dev when the live provider call throws", async () => {
    process.env.__CATALOG_FAIL_KEYS__ = "sk-bad-key";
    let calls = 0;
    installFetch(async (_url) => {
      calls++;
      if (calls === 1) throw new Error("network error");
      return jsonResponse({
        openai: { models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT 5.5" } } },
      });
    });
    const result = await getAvailableModels({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      keyEnv: "__CATALOG_FAIL_KEYS__",
    });
    expect(result.source).toBe("catalog");
    expect(result.models).toEqual([{ id: "gpt-5.5", label: "GPT 5.5", source: "catalog" }]);
  });

  it("maps our 'gemini'/'google' provider ids to models.dev's 'google' key", async () => {
    installFetch(async () =>
      jsonResponse({
        google: { models: { "gemini-3.5-flash": { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" } } },
      }),
    );
    const result = await getAvailableModels({
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      keyEnv: "__NO_SUCH_KEY_ENV_2__",
    });
    expect(result.source).toBe("catalog");
    expect(result.models.map((m) => m.id)).toEqual(["gemini-3.5-flash"]);
  });

  it("never throws on a malformed models.dev catalog", async () => {
    installFetch(async () => jsonResponse({ not: "the expected shape" }));
    const result = await getAvailableModels({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      keyEnv: "__NO_SUCH_KEY_ENV_3__",
    });
    expect(result.source).toBe("catalog");
    expect(result.models).toEqual([]);
  });

  it("returns empty catalog (never throws) when models.dev itself is unreachable", async () => {
    installFetch(async () => {
      throw new Error("dns failure");
    });
    const result = await getAvailableModels({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      keyEnv: "__NO_SUCH_KEY_ENV_4__",
    });
    expect(result.source).toBe("catalog");
    expect(result.models).toEqual([]);
  });
});

describe("modelCatalog: caching", () => {
  it("caches a provider result and does not re-fetch within the TTL", async () => {
    process.env.__CATALOG_CACHE_KEYS__ = "sk-cache-test-key-unique-1";
    let calls = 0;
    installFetch(async () => {
      calls++;
      return jsonResponse({ data: [{ id: "gpt-cache-test" }] });
    });
    const opts = {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      keyEnv: "__CATALOG_CACHE_KEYS__",
    };
    const first = await getAvailableModels(opts);
    const second = await getAvailableModels(opts);
    expect(first.models).toEqual(second.models);
    expect(calls).toBe(1); // second call served from cache, no second fetch
  });

  it("caches the models.dev fallback independently per provider", async () => {
    let calls = 0;
    installFetch(async () => {
      calls++;
      return jsonResponse({
        openai: { models: { "gpt-cache-fallback": { id: "gpt-cache-fallback", name: "GPT Cache Fallback" } } },
      });
    });
    const opts = {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      keyEnv: "__NO_SUCH_KEY_ENV_CACHE__",
    };
    await getAvailableModels(opts);
    await getAvailableModels(opts);
    expect(calls).toBe(1);
  });
});

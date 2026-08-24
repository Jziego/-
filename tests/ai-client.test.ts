import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock the openai SDK ─────────────────────────────────────────────────────
// ai-client instantiates `new OpenAI(...)` at module scope (singleton), so we
// mock the whole module with a class whose chat.completions.create is a vi.fn
// shared via vi.hoisted (the mock factory is hoisted above imports).
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mocks.create } };
  },
}));

type AiClientModule = typeof import("@/lib/services/ai-client");

/** Fresh module instance per test: resets the module-level _client singleton. */
async function importFreshClient(): Promise<AiClientModule> {
  vi.resetModules();
  process.env.OPENAI_API_KEY = "test-key";
  return import("@/lib/services/ai-client");
}

function completion(content: string | null) {
  return { choices: [{ message: { content } }] };
}

describe("ai-client", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    // Keep retry warnings / error logs out of the test output.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_REASONING_EFFORT;
  });

  it("sends reasoning_effort 'low' by default (deepseek reasoning tokens count against max_tokens)", async () => {
    const mod = await importFreshClient();
    mocks.create.mockResolvedValue(completion("hello"));

    const result = await mod.chatCompletion("sys", "user");

    expect(result).toBe("hello");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const params = mocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.reasoning_effort).toBe("low");
  });

  it("sends the configured AI_REASONING_EFFORT value", async () => {
    process.env.AI_REASONING_EFFORT = "high";
    const mod = await importFreshClient();
    mocks.create.mockResolvedValue(completion("hello"));

    await mod.chatCompletion("sys", "user");

    const params = mocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort when AI_REASONING_EFFORT=off", async () => {
    process.env.AI_REASONING_EFFORT = "off";
    const mod = await importFreshClient();
    mocks.create.mockResolvedValue(completion("hello"));

    await mod.chatCompletion("sys", "user");

    const params = mocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.reasoning_effort).toBeUndefined();
  });

  it("per-call reasoningEffort option overrides the env default", async () => {
    const mod = await importFreshClient();
    mocks.create.mockResolvedValue(completion("hello"));

    await mod.chatCompletion("sys", "user", { reasoningEffort: "high" });

    const params = mocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.reasoning_effort).toBe("high");
  });

  it("per-call reasoningEffort beats AI_REASONING_EFFORT env when both set", async () => {
    process.env.AI_REASONING_EFFORT = "minimal";
    const mod = await importFreshClient();
    mocks.create.mockResolvedValue(completion('{"a":1}'));

    await mod.chatCompletionJSON("sys", "user", { reasoningEffort: "high" });

    const params = mocks.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.reasoning_effort).toBe("high");
  });

  it("respects per-call maxAttempts (no retry when maxAttempts=1)", async () => {
    const mod = await importFreshClient();
    mocks.create.mockResolvedValue(completion(""));

    const result = await mod.chatCompletionJSON("sys", "user", { maxAttempts: 1 });

    expect(result).toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("returns parsed JSON on first success without retrying", async () => {
    const mod = await importFreshClient();
    mocks.create.mockResolvedValue(completion('{"a":1}'));

    const result = await mod.chatCompletionJSON<{ a: number }>("sys", "user");

    expect(result).toEqual({ a: 1 });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("retries on empty content and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    const mod = await importFreshClient();
    mocks.create
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion('{"a":2}'));

    const p = mod.chatCompletionJSON<{ a: number }>("sys", "user");
    const assertion = expect(p).resolves.toEqual({ a: 2 });
    await vi.runAllTimersAsync();

    await assertion;
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("retries on unparseable JSON and succeeds on the second attempt", async () => {
    vi.useFakeTimers();
    const mod = await importFreshClient();
    mocks.create
      .mockResolvedValueOnce(completion("{bad json"))
      .mockResolvedValueOnce(completion('{"a":3}'));

    const p = mod.chatCompletionJSON<{ a: number }>("sys", "user");
    const assertion = expect(p).resolves.toEqual({ a: 3 });
    await vi.runAllTimersAsync();

    await assertion;
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("returns null after 3 attempts when content stays empty", async () => {
    vi.useFakeTimers();
    const mod = await importFreshClient();
    mocks.create.mockResolvedValue(completion("   "));

    const p = mod.chatCompletionJSON("sys", "user");
    const assertion = expect(p).resolves.toBeNull();
    await vi.runAllTimersAsync();

    await assertion;
    expect(mocks.create).toHaveBeenCalledTimes(3);
  });

  it("chatCompletion (non-JSON) also retries on empty content", async () => {
    vi.useFakeTimers();
    const mod = await importFreshClient();
    mocks.create
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion("  你好  "));

    const p = mod.chatCompletion("sys", "user");
    const assertion = expect(p).resolves.toBe("你好");
    await vi.runAllTimersAsync();

    await assertion;
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("does not business-retry SDK/network errors and rethrows immediately", async () => {
    const mod = await importFreshClient();
    mocks.create.mockRejectedValue(new Error("connection reset"));

    await expect(mod.chatCompletionJSON("sys", "user")).rejects.toThrow("connection reset");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});

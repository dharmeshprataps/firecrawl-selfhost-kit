const state = vi.hoisted(() => ({
  config: { OLLAMA_BASE_URL: "http://host.lima.internal:11435/api" as string | undefined, MODEL_NAME: "qwen2.5:3b" as string | undefined, MODEL_EMBEDDING_NAME: undefined as string | undefined },
  local: vi.fn((name: string) => ({ modelId: name, provider: "ollama" })),
  embedding: vi.fn((name: string) => ({ modelId: name, provider: "ollama.embedding" })),
  cloud: vi.fn((name: string) => ({ modelId: name, provider: "cloud" })),
}));
vi.mock("../config", () => ({ config: state.config }));
vi.mock("ollama-ai-provider-v2", () => ({ createOllama: () => Object.assign(state.local, { embedding: state.embedding }) }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => Object.assign(state.cloud, { chat: state.cloud, embedding: state.cloud }) }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: state.cloud }));
vi.mock("@ai-sdk/groq", () => ({ groq: state.cloud }));
vi.mock("@ai-sdk/google", () => ({ google: state.cloud }));
vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter: () => state.cloud }));
vi.mock("@ai-sdk/fireworks", () => ({ fireworks: state.cloud }));
vi.mock("@ai-sdk/deepinfra", () => ({ deepinfra: state.cloud }));
vi.mock("@ai-sdk/google-vertex", () => ({ createVertex: () => state.cloud }));
import { getEmbeddingModel, getModel } from "./generic-ai";
beforeEach(() => {
  vi.clearAllMocks();
  state.config.OLLAMA_BASE_URL = "http://host.lima.internal:11435/api";
  state.config.MODEL_NAME = "qwen2.5:3b";
  state.config.MODEL_EMBEDDING_NAME = undefined;
});
describe("Local provider selection cannot select Cloud", () => {
  it("overrides every explicitly requested provider and retry model", () => {
    for (const provider of ["openai", "ollama", "anthropic", "groq", "google", "openrouter", "fireworks", "deepinfra", "vertex"] as const) {
      expect(getModel("gpt-4.1-mini", provider)).toEqual({ modelId: "qwen2.5:3b", provider: "ollama" });
    }
    expect(state.local).toHaveBeenCalledTimes(9); expect(state.cloud).not.toHaveBeenCalled();
  });
  it("rejects missing or unreviewed model configuration instead of using the requested cloud model", () => {
    state.config.MODEL_NAME = undefined;
    expect(() => getModel("gpt-4o", "openai")).toThrow("pinned");
    state.config.MODEL_NAME = "gpt-4o:cloud";
    expect(() => getModel("gpt-4o", "openai")).toThrow("pinned");
    expect(state.cloud).not.toHaveBeenCalled(); expect(state.local).not.toHaveBeenCalled();
  });
  it("requires an explicit embedding model and keeps embeddings on Ollama", () => {
    expect(() => getEmbeddingModel("text-embedding-3-small", "openai")).toThrow("explicitly configured local embedding model");
    state.config.MODEL_EMBEDDING_NAME = "nomic-embed-text";
    expect(getEmbeddingModel("text-embedding-3-small", "openai")).toEqual({ modelId: "nomic-embed-text", provider: "ollama.embedding" });
    expect(state.cloud).not.toHaveBeenCalled();
  });
  it("preserves explicit cloud selection when local inference is not configured", () => {
    state.config.OLLAMA_BASE_URL = undefined; state.config.MODEL_NAME = undefined;
    expect(getModel("gpt-4o", "openai")).toEqual({ modelId: "gpt-4o", provider: "cloud" });
  });
});

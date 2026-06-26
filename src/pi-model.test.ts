import { describe, expect, it } from "vitest";
import { piModel } from "./pi-model.js";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";

const model: Model<Api> = {
  api: "test-api",
  baseUrl: "https://example.com",
  contextWindow: 128_000,
  cost: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
  },
  id: "test-model",
  input: ["text"],
  maxTokens: 16_000,
  name: "Test Model",
  provider: "test-provider",
  reasoning: false,
};

describe("piModel", () => {
  it("adapts PI completeSimple into an AI SDK language model", async () => {
    let capturedContext: Context | undefined;
    const languageModel = piModel({
      model,
      models: {
        completeSimple: async (_model, context) => {
          capturedContext = context;
          return assistantMessage("hello from PI");
        },
      } as Partial<Models> as Models,
    });

    const result = await languageModel.doGenerate({
      prompt: [
        { content: "You are helpful.", role: "system" },
        { content: [{ text: "Hi", type: "text" }], role: "user" },
      ],
    });

    expect(capturedContext).toMatchObject({
      messages: [{ role: "user" }],
      systemPrompt: "You are helpful.",
    });
    expect(result.content).toEqual([{ text: "hello from PI", type: "text" }]);
    expect(result.finishReason).toEqual({ raw: "stop", unified: "stop" });
  });

  it("warns when AI SDK tools are passed to the model adapter", async () => {
    const languageModel = piModel({
      model,
      models: {
        completeSimple: async () => assistantMessage("tool warning"),
      } as Partial<Models> as Models,
    });

    const result = await languageModel.doGenerate({
      prompt: [{ content: [{ text: "Hi", type: "text" }], role: "user" }],
      tools: [
        {
          description: "Lookup",
          inputSchema: { type: "object" },
          name: "lookup",
          type: "function",
        },
      ],
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        feature: "AI SDK client-side tools",
        type: "unsupported",
      }),
    ]);
  });
});

function assistantMessage(text: string): AssistantMessage {
  return {
    api: "test-api",
    content: [{ text, type: "text" }],
    model: "test-model",
    provider: "test-provider",
    role: "assistant",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 1,
        output: 2,
        total: 3,
      },
      input: 1,
      output: 2,
      totalTokens: 3,
    },
  };
}

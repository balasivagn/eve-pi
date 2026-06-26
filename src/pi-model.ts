import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  Models,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  Usage,
} from "@earendil-works/pi-ai";

export interface PiModelConfig<TApi extends Api = Api> {
  /**
   * PI model runtime. Create this with PI's `createModels()` or `builtinModels()`
   * and configure credentials using PI's own auth APIs.
   */
  readonly models: Models;
  /**
   * PI model descriptor, usually from `getBuiltinModel(...)`.
   */
  readonly model: Model<TApi>;
  /**
   * AI SDK provider id exposed to eve. Defaults to `pi`.
   */
  readonly providerId?: string;
  /**
   * Reasoning level forwarded to PI's `streamSimple`/`completeSimple`.
   */
  readonly reasoning?: SimpleStreamOptions["reasoning"];
}

/**
 * Adapts PI's model/provider layer to an AI SDK language model.
 *
 * This is the model-level integration: eve owns the agent/tool loop and calls
 * PI like a model provider. For full PI coding-agent behavior, use `piRunner`.
 */
export function piModel<TApi extends Api>(config: PiModelConfig<TApi>): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: config.providerId ?? "pi",
    modelId: `${config.model.provider}/${config.model.id}`,
    supportedUrls: {},
    async doGenerate(options) {
      const piOptions = toPiOptions(options, config);
      const message = await config.models.completeSimple(config.model, toPiContext(options.prompt, config.model), piOptions);

      return {
        content: toLanguageModelContent(message),
        finishReason: toLanguageModelFinishReason(message.stopReason),
        usage: toLanguageModelUsage(message.usage),
        warnings: collectWarnings(options),
      };
    },
    async doStream(options) {
      const piOptions = toPiOptions(options, config);
      const stream = config.models.streamSimple(config.model, toPiContext(options.prompt, config.model), piOptions);

      return {
        stream: toLanguageModelStream(stream, options),
      };
    },
  };
}

function toPiContext(prompt: LanguageModelV4Prompt, model: Model<Api>): Context {
  const systemPrompt = prompt
    .filter((message): message is Extract<LanguageModelV4Message, { role: "system" }> => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const messages: Message[] = [];
  for (const message of prompt) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      messages.push({
        content: message.content.filter(isTextPromptPart).map((part) => ({ text: part.text, type: "text" })),
        role: "user",
        timestamp: Date.now(),
      });
      continue;
    }

    if (message.role === "assistant") {
      const assistantContent: Array<TextContent | ThinkingContent> = message.content.flatMap(
        (part): Array<TextContent | ThinkingContent> => {
          if (part.type === "text") return [{ text: part.text, type: "text" }];
          if (part.type === "reasoning") return [{ thinking: part.text, type: "thinking" }];
          return [];
        },
      );

      messages.push({
        api: model.api,
        content: assistantContent,
        model: model.id,
        provider: model.provider,
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: emptyPiUsage(),
      });
      continue;
    }

    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        messages.push({
          content: [{ text: JSON.stringify(part.output), type: "text" }],
          isError: false,
          role: "toolResult",
          timestamp: Date.now(),
          toolCallId: part.toolCallId,
          toolName: part.toolName,
        });
      }
    }
  }

  return {
    ...(systemPrompt.length === 0 ? {} : { systemPrompt }),
    messages,
  };
}

function toPiOptions<TApi extends Api>(
  options: LanguageModelV4CallOptions,
  config: PiModelConfig<TApi>,
): SimpleStreamOptions {
  return {
    ...(options.abortSignal === undefined ? {} : { signal: options.abortSignal }),
    ...(options.maxOutputTokens === undefined ? {} : { maxTokens: options.maxOutputTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }),
  };
}

function toLanguageModelContent(message: AssistantMessage): LanguageModelV4Content[] {
  return message.content.flatMap((part): LanguageModelV4Content[] => {
    if (part.type === "text") return [{ text: part.text, type: "text" }];
    if (part.type === "thinking") return [{ text: part.thinking, type: "reasoning" }];
    if (part.type === "toolCall") {
      return [
        {
          input: JSON.stringify(part.arguments),
          toolCallId: part.id,
          toolName: part.name,
          type: "tool-call",
        },
      ];
    }
    return [];
  });
}

function toLanguageModelStream(
  stream: AsyncIterable<AssistantMessageEvent>,
  options: LanguageModelV4CallOptions,
): ReadableStream<LanguageModelV4StreamPart> {
  const warnings = collectWarnings(options);

  return new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      controller.enqueue({ type: "stream-start", warnings });

      for await (const event of stream) {
        if (event.type === "text_start") {
          controller.enqueue({ id: `text-${event.contentIndex}`, type: "text-start" });
        } else if (event.type === "text_delta") {
          controller.enqueue({ delta: event.delta, id: `text-${event.contentIndex}`, type: "text-delta" });
        } else if (event.type === "text_end") {
          controller.enqueue({ id: `text-${event.contentIndex}`, type: "text-end" });
        } else if (event.type === "thinking_start") {
          controller.enqueue({ id: `reasoning-${event.contentIndex}`, type: "reasoning-start" });
        } else if (event.type === "thinking_delta") {
          controller.enqueue({ delta: event.delta, id: `reasoning-${event.contentIndex}`, type: "reasoning-delta" });
        } else if (event.type === "thinking_end") {
          controller.enqueue({ id: `reasoning-${event.contentIndex}`, type: "reasoning-end" });
        } else if (event.type === "done") {
          controller.enqueue({
            finishReason: toLanguageModelFinishReason(event.message.stopReason),
            type: "finish",
            usage: toLanguageModelUsage(event.message.usage),
          });
        } else if (event.type === "error") {
          controller.enqueue({ error: event.error.errorMessage ?? "PI model stream failed.", type: "error" });
        }
      }

      controller.close();
    },
  });
}

function toLanguageModelUsage(usage: Usage | undefined): LanguageModelV4Usage {
  return {
    inputTokens: {
      cacheRead: usage?.cacheRead,
      cacheWrite: usage?.cacheWrite,
      noCache: usage === undefined ? undefined : Math.max(usage.input - usage.cacheRead, 0),
      total: usage?.input,
    },
    outputTokens: {
      reasoning: undefined,
      text: usage?.output,
      total: usage?.output,
    },
    ...(usage === undefined
      ? {}
      : {
          raw: {
            pi: {
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              input: usage.input,
              output: usage.output,
              totalTokens: usage.totalTokens,
            },
          },
        }),
  };
}

function toLanguageModelFinishReason(reason: StopReason): LanguageModelV4FinishReason {
  if (reason === "length") return { raw: reason, unified: "length" };
  if (reason === "toolUse") return { raw: reason, unified: "tool-calls" };
  if (reason === "error" || reason === "aborted") return { raw: reason, unified: "error" };
  return { raw: reason, unified: "stop" };
}

function collectWarnings(options: LanguageModelV4CallOptions): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  if (options.tools !== undefined && options.tools.length > 0) {
    warnings.push({
      feature: "AI SDK client-side tools",
      type: "unsupported",
      details: "piModel does not translate AI SDK tools into PI tool definitions yet. Use piRunner for PI-owned tools.",
    });
  }
  return warnings;
}

function isTextPromptPart(
  part: Extract<LanguageModelV4Message, { role: "user" }>["content"][number],
): part is Extract<Extract<LanguageModelV4Message, { role: "user" }>["content"][number], { type: "text" }> {
  return part.type === "text";
}

function emptyPiUsage(): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      total: 0,
    },
    input: 0,
    output: 0,
    totalTokens: 0,
  };
}

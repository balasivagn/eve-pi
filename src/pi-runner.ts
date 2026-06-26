import { defineRunner } from "eve";
import { PiRpcClient, validateCommand } from "./pi-rpc-client.js";
import type { PiAgentEvent, PiAssistantMessage, PiContentBlock, PiRunnerConfig } from "./types.js";

export const PI_SESSION_FILE_STATE_KEY = "$pi.sessionFile";
export const DEFAULT_PI_TURN_TIMEOUT_MS = 300_000;

export function piRunner(config: PiRunnerConfig = {}) {
  validatePiRunnerConfig(config);

  return defineRunner({
    createStep(context) {
      return async (session, input) => {
        const client = new PiRpcClient({
          command: buildPiCommand(config),
          cwd: config.cwd ?? context.cwd ?? process.cwd(),
          ...(config.env === undefined ? {} : { env: config.env }),
          ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
        });

        try {
          await client.start();

          const previousSessionFile = readPiSessionFile(session);
          if (previousSessionFile !== undefined) {
            await client.switchSession(previousSessionFile);
          }

          const events = await client.promptAndWait(buildPrompt(session, input), config.timeoutMs ?? DEFAULT_PI_TURN_TIMEOUT_MS);
          const response = extractFinalAssistantText(events);
          const state = await client.getState();
          const sessionFile = state.sessionFile ?? previousSessionFile;
          const nextSession = applyPiResult(session, input, {
            response,
            ...(sessionFile === undefined ? {} : { sessionFile }),
          });

          return context.mode === "task"
            ? { next: { done: true, output: response }, session: nextSession }
            : { next: null, session: nextSession };
        } finally {
          await client.stop();
        }
      };
    },
  });
}

export function readPiSessionFile(session: RunnerSession): string | undefined {
  const value = session.state?.[PI_SESSION_FILE_STATE_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildPiCommand(config: PiRunnerConfig): readonly string[] {
  const command = config.command ?? ["pi", "--mode", "rpc"];
  const args = [...command];

  if (!args.includes("--mode")) {
    args.push("--mode", "rpc");
  }
  if (config.provider !== undefined) {
    args.push("--provider", config.provider);
  }
  if (config.model !== undefined) {
    args.push("--model", config.model);
  }
  if (config.args !== undefined) {
    args.push(...config.args);
  }

  return args;
}

function validatePiRunnerConfig(config: PiRunnerConfig): void {
  if (config.command !== undefined) {
    validateCommand(config.command, "piRunner()");
  }
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new Error("piRunner(): timeoutMs must be a positive integer when provided.");
  }
  if (
    config.requestTimeoutMs !== undefined &&
    (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)
  ) {
    throw new Error("piRunner(): requestTimeoutMs must be a positive integer when provided.");
  }
}

function buildPrompt(session: RunnerSession, input: RunnerInput | undefined): string {
  const parts: string[] = [];

  if (readPiSessionFile(session) === undefined && session.agent.system.trim().length > 0) {
    parts.push(`System instructions:\n${session.agent.system}`);
  }

  for (const context of input?.context ?? []) {
    parts.push(context);
  }

  if (typeof input?.message === "string") {
    parts.push(input.message);
  } else if (Array.isArray(input?.message)) {
    const text = input.message
      .filter((part): part is { readonly text: string; readonly type: "text" } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.length > 0) {
      parts.push(text);
    }
  }

  return parts.join("\n\n");
}

function extractFinalAssistantText(events: readonly PiAgentEvent[]): string {
  const agentEnd = events.findLast((event): event is Extract<PiAgentEvent, { type: "agent_end" }> => {
    return event.type === "agent_end";
  });
  const assistantMessage = agentEnd?.messages.findLast(isPiAssistantMessage);
  const text = assistantMessage?.content.filter(isTextBlock).map((block) => block.text).join("\n").trim();

  if (text === undefined || text.length === 0) {
    throw new Error("PI completed without a final assistant text response.");
  }

  return text;
}

function applyPiResult(
  session: RunnerSession,
  input: RunnerInput | undefined,
  result: { readonly response: string; readonly sessionFile?: string },
): RunnerSession {
  const history = [...session.history];
  if (input?.message !== undefined) {
    history.push({ content: input.message, role: "user" });
  }
  history.push({
    content: [{ text: result.response, type: "text" }],
    role: "assistant",
  });

  return {
    ...session,
    history,
    state: {
      ...session.state,
      ...(result.sessionFile === undefined ? {} : { [PI_SESSION_FILE_STATE_KEY]: result.sessionFile }),
    },
  };
}

function isPiAssistantMessage(value: unknown): value is PiAssistantMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    "content" in value &&
    Array.isArray(value.content)
  );
}

function isTextBlock(block: PiContentBlock): block is Extract<PiContentBlock, { type: "text" }> {
  return block.type === "text";
}

type RunnerSession = Parameters<ReturnType<ReturnType<typeof defineRunner>["createStep"]>>[0];
type RunnerInput = Parameters<ReturnType<ReturnType<typeof defineRunner>["createStep"]>>[1];

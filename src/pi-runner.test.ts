import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_SESSION_FILE_STATE_KEY, piRunner } from "./pi-runner.js";

const fixturePath = fileURLToPath(new URL("./test-fixtures/fake-pi-rpc.mjs", import.meta.url));

describe("piRunner", () => {
  it("runs PI as an eve runner and persists the PI session file", async () => {
    const runner = piRunner({
      command: [process.execPath, fixturePath],
      requestTimeoutMs: 1_000,
      timeoutMs: 1_000,
    });
    const step = runner.createStep({
      mode: "task",
      tools: new Map(),
    });

    const result = await step(
      {
        agent: { system: "You are a reviewer." },
        compaction: undefined,
        continuationToken: undefined,
        history: [],
        sessionId: "test-session",
        state: {},
      } as unknown as Parameters<typeof step>[0],
      {
        context: ["Repository: demo"],
        message: "Review the diff",
      } as Parameters<typeof step>[1],
    );

    expect(result.next).toEqual({ done: true, output: "PI saw: System instructions:\nYou are a reviewer.\n\nRepository: demo\n\nReview the diff" });
    expect(result.session.state?.[PI_SESSION_FILE_STATE_KEY]).toBe("/tmp/pi-session.jsonl");
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: (result.next as { output: string }).output, type: "text" }],
      role: "assistant",
    });
  });

  it("uses the existing PI session file on later turns", async () => {
    const runner = piRunner({
      command: [process.execPath, fixturePath],
      requestTimeoutMs: 1_000,
      timeoutMs: 1_000,
    });
    const step = runner.createStep({
      mode: "task",
      tools: new Map(),
    });

    const result = await step(
      {
        agent: { system: "Should not be resent." },
        compaction: undefined,
        continuationToken: undefined,
        history: [],
        sessionId: "test-session",
        state: { [PI_SESSION_FILE_STATE_KEY]: "/tmp/existing-session.jsonl" },
      } as unknown as Parameters<typeof step>[0],
      {
        message: "Continue",
      } as Parameters<typeof step>[1],
    );

    expect(result.next).toEqual({ done: true, output: "PI saw: Continue" });
    expect(result.session.state?.[PI_SESSION_FILE_STATE_KEY]).toBe("/tmp/existing-session.jsonl");
  });
});

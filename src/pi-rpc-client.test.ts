import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PiRpcClient } from "./pi-rpc-client.js";

const fixturePath = fileURLToPath(new URL("./test-fixtures/fake-pi-rpc.mjs", import.meta.url));

describe("PiRpcClient", () => {
  it("sends prompts and collects PI events until agent_end", async () => {
    const client = new PiRpcClient({
      command: [process.execPath, fixturePath],
      requestTimeoutMs: 1_000,
    });

    await client.start();
    try {
      const events = await client.promptAndWait("review this PR", 1_000);
      const state = await client.getState();

      expect(events.at(-1)).toMatchObject({
        messages: [
          {
            content: [{ text: "PI saw: review this PR", type: "text" }],
            role: "assistant",
          },
        ],
        type: "agent_end",
      });
      expect(state.sessionFile).toBe("/tmp/pi-session.jsonl");
    } finally {
      await client.stop();
    }
  });

  it("can switch to an existing PI session", async () => {
    const client = new PiRpcClient({
      command: [process.execPath, fixturePath],
      requestTimeoutMs: 1_000,
    });

    await client.start();
    try {
      await client.switchSession("/tmp/existing-session.jsonl");
      const state = await client.getState();

      expect(state.sessionFile).toBe("/tmp/existing-session.jsonl");
    } finally {
      await client.stop();
    }
  });
});

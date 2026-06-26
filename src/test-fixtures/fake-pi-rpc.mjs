import process from "node:process";

let buffer = "";
let sessionFile = "/tmp/pi-session.jsonl";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) break;
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    handle(JSON.parse(line));
  }
});

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(command) {
  if (command.type === "switch_session") {
    sessionFile = command.sessionPath;
    write({ id: command.id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }

  if (command.type === "get_state") {
    write({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionFile, sessionId: "fake-session" },
    });
    return;
  }

  if (command.type === "prompt") {
    write({ id: command.id, type: "response", command: "prompt", success: true });
    write({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: `PI saw: ${command.message}` }],
        },
      ],
    });
    return;
  }

  write({ id: command.id, type: "response", command: command.type, success: false, error: "unknown command" });
}

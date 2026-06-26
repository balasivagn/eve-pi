import { type ChildProcess, spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type { PiAgentEvent, PiRpcClientOptions, PiRpcResponse, PiSessionState } from "./types.js";

type PiRpcCommandBody =
  | { readonly type: "prompt"; readonly message: string }
  | { readonly type: "switch_session"; readonly sessionPath: string }
  | { readonly type: "get_state" };

export class PiRpcClient {
  private readonly options: PiRpcClientOptions;
  private eventListeners: Array<(event: PiAgentEvent) => void> = [];
  private exitError: Error | undefined;
  private pendingRequests = new Map<string, { reject: (error: Error) => void; resolve: (response: PiRpcResponse) => void }>();
  private process: ChildProcess | undefined;
  private requestId = 0;
  private stderr = "";
  private stopReadingStdout: (() => void) | undefined;

  constructor(options: PiRpcClientOptions) {
    validateCommand(options.command, "PiRpcClient");
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.process !== undefined) {
      throw new Error("PI RPC client already started.");
    }

    const [command, ...args] = this.options.command;
    const childProcess = spawn(command!, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = childProcess;

    childProcess.stderr?.on("data", (data: Buffer | string) => {
      this.stderr += data.toString();
    });

    childProcess.once("exit", (code, signal) => {
      if (this.process !== childProcess) return;
      const error = new Error(`PI RPC process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
      this.exitError = error;
      this.rejectPendingRequests(error);
    });

    childProcess.once("error", (error) => {
      if (this.process !== childProcess) return;
      const processError = new Error(`PI RPC process error: ${error.message}. Stderr: ${this.stderr}`);
      this.exitError = processError;
      this.rejectPendingRequests(processError);
    });

    childProcess.stdin?.on("error", (error) => {
      if (this.process !== childProcess) return;
      const stdinError = this.exitError ?? new Error(`PI RPC stdin error: ${error.message}. Stderr: ${this.stderr}`);
      this.exitError = stdinError;
      this.rejectPendingRequests(stdinError);
    });

    this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
      this.handleLine(line);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    if (childProcess.exitCode !== null) {
      throw this.exitError ?? new Error(`PI RPC process exited before startup. Stderr: ${this.stderr}`);
    }
  }

  async stop(): Promise<void> {
    const childProcess = this.process;
    if (childProcess === undefined) return;

    this.stopReadingStdout?.();
    this.stopReadingStdout = undefined;
    childProcess.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        childProcess.kill("SIGKILL");
        resolve();
      }, 1000);

      childProcess.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.process = undefined;
    this.pendingRequests.clear();
  }

  onEvent(listener: (event: PiAgentEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((candidate) => candidate !== listener);
    };
  }

  getStderr(): string {
    return this.stderr;
  }

  async prompt(message: string): Promise<void> {
    await this.send({ type: "prompt", message });
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.send({ type: "switch_session", sessionPath });
  }

  async getState(): Promise<PiSessionState> {
    const response = await this.send({ type: "get_state" });
    return readResponseData<PiSessionState>(response) ?? {};
  }

  collectEvents(timeoutMs: number): Promise<PiAgentEvent[]> {
    return new Promise((resolve, reject) => {
      const events: PiAgentEvent[] = [];
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for PI agent_end. Stderr: ${this.stderr}`));
      }, timeoutMs);

      const unsubscribe = this.onEvent((event) => {
        events.push(event);
        if (event.type === "agent_end") {
          clearTimeout(timeout);
          unsubscribe();
          resolve(events);
        }
      });
    });
  }

  async promptAndWait(message: string, timeoutMs: number): Promise<PiAgentEvent[]> {
    const eventsPromise = this.collectEvents(timeoutMs);
    await this.prompt(message);
    return eventsPromise;
  }

  private async send(command: PiRpcCommandBody): Promise<PiRpcResponse> {
    const childProcess = this.process;
    const stdin = childProcess?.stdin;
    if (childProcess === undefined || stdin === undefined || stdin === null) {
      throw new Error("PI RPC client is not started.");
    }
    if (this.exitError !== undefined) {
      throw this.exitError;
    }
    if (childProcess.exitCode !== null) {
      throw new Error(`PI RPC process already exited. Stderr: ${this.stderr}`);
    }
    if (stdin.destroyed || !stdin.writable) {
      throw new Error(`PI RPC stdin is not writable. Stderr: ${this.stderr}`);
    }

    const id = `req_${++this.requestId}`;
    const requestTimeoutMs = this.options.requestTimeoutMs ?? 30_000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for PI response to ${command.type}. Stderr: ${this.stderr}`));
      }, requestTimeoutMs);

      this.pendingRequests.set(id, {
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        resolve: (response) => {
          clearTimeout(timeout);
          if (!response.success) {
            reject(new Error(response.error));
            return;
          }
          resolve(response);
        },
      });

      stdin.write(serializeJsonLine({ ...command, id }));
    });
  }

  private handleLine(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }

    if (isRpcResponse(data) && data.id !== undefined && this.pendingRequests.has(data.id)) {
      const pending = this.pendingRequests.get(data.id)!;
      this.pendingRequests.delete(data.id);
      pending.resolve(data);
      return;
    }

    if (isAgentEvent(data)) {
      for (const listener of this.eventListeners) {
        listener(data);
      }
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

export function validateCommand(command: readonly string[], owner: string): void {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error(`${owner}: command must be a non-empty array of strings.`);
  }
  for (const entry of command) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${owner}: command entries must be non-empty strings.`);
    }
  }
}

function isRpcResponse(value: unknown): value is PiRpcResponse & { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "response" &&
    "id" in value &&
    typeof value.id === "string"
  );
}

function isAgentEvent(value: unknown): value is PiAgentEvent {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function readResponseData<T>(response: PiRpcResponse): T | undefined {
  if (!response.success) {
    throw new Error(response.error);
  }
  return "data" in response ? (response.data as T) : undefined;
}

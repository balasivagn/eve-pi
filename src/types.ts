export interface PiRunnerConfig {
  /**
   * PI command to spawn. Defaults to `["pi", "--mode", "rpc"]`.
   */
  readonly command?: readonly string[];
  /**
   * Working directory for PI. Defaults to eve's runner cwd, then `process.cwd()`.
   */
  readonly cwd?: string;
  /**
   * Environment variables merged over `process.env`.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * PI provider passed as `--provider`.
   */
  readonly provider?: string;
  /**
   * PI model passed as `--model`.
   */
  readonly model?: string;
  /**
   * Extra CLI arguments appended after `--mode rpc` and model options.
   */
  readonly args?: readonly string[];
  /**
   * Timeout for a full PI turn. Defaults to 5 minutes.
   */
  readonly timeoutMs?: number;
  /**
   * Timeout for a single RPC command response. Defaults to 30 seconds.
   */
  readonly requestTimeoutMs?: number;
}

export interface PiRpcClientOptions {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
}

export type PiRpcCommand =
  | { id?: string; type: "prompt"; message: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "get_state" };

export type PiRpcResponse =
  | { id?: string; type: "response"; command: string; success: true; data?: unknown }
  | { id?: string; type: "response"; command: string; success: false; error: string };

export interface PiSessionState {
  readonly sessionFile?: string;
  readonly sessionId?: string;
}

export interface PiTextContentBlock {
  readonly type: "text";
  readonly text: string;
}

export interface PiThinkingContentBlock {
  readonly type: "thinking";
  readonly thinking: string;
}

export interface PiToolCallBlock {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type PiContentBlock = PiTextContentBlock | PiThinkingContentBlock | PiToolCallBlock;

export interface PiAssistantMessage {
  readonly role: "assistant";
  readonly content: readonly PiContentBlock[];
}

export type PiAgentEvent =
  | { type: "agent_end"; messages: readonly unknown[] }
  | { type: "message_update"; assistantMessageEvent?: unknown; message?: unknown }
  | { type: string; [key: string]: unknown };

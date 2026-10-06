export type CodexLoginMethod = "browser" | "device";
export interface CodexLogin { id: string; method: CodexLoginMethod; url: string; userCode?: string; expiresAt: string }
export interface CodexStatus {
  configured: boolean; connected: boolean;
  account: { email: string; planType: string } | null;
  login: CodexLogin | null; loginError: string | null; activeRuns: number;
}
export interface CodexModel {
  id: string; name: string; isDefault: boolean;
  supportedReasoningEfforts: readonly { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string | null;
}
export interface CodexChatMessage { role: "user" | "assistant"; text: string }
export interface CodexTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface CodexToolCall { readonly id: string; readonly name: string; readonly arguments: unknown; }
export interface CodexToolResult { readonly text: string; readonly success: boolean; }
export interface CodexRunInput {
  model?: string; reasoningEffort?: string; instructions: string; messages: readonly CodexChatMessage[];
  signal: AbortSignal; onTextDelta: (text: string) => void;
  tools?: readonly CodexTool[];
  onToolCall?: (call: CodexToolCall, signal: AbortSignal) => Promise<CodexToolResult>;
}
export interface CodexConfigShape { enabled: boolean; binary: string; stateDirectory: string }
/** Narrow application API. Wire RPC, credentials and process handles are private. */
export interface CodexClient {
  status(): Promise<CodexStatus>;
  login(method: CodexLoginMethod): Promise<CodexStatus>;
  cancelLogin(): Promise<CodexStatus>;
  logout(): Promise<CodexStatus>;
  models(): Promise<readonly CodexModel[]>;
  run(input: CodexRunInput): Promise<string>;
}
export type CodexErrorCode =
  | "NOT_CONFIGURED" | "UNAVAILABLE" | "SIGN_IN_REQUIRED" | "BUSY" | "MODEL_UNAVAILABLE" | "REASONING_UNAVAILABLE"
  | "PROTOCOL_ERROR" | "RESPONSE_FAILED" | "TIMEOUT" | "LOGIN_FAILED" | "LOGIN_EXPIRED";

const EN_CODEX_MESSAGES: Readonly<Record<CodexErrorCode, string>> = Object.freeze({
  NOT_CONFIGURED: "The ChatGPT connection is not configured on the server.",
  UNAVAILABLE: "Codex App Server is unavailable. Check its installation and settings.",
  SIGN_IN_REQUIRED: "An administrator needs to connect a ChatGPT account.",
  BUSY: "Wait until the current replies or the ChatGPT sign-in finish.",
  MODEL_UNAVAILABLE: "The selected model is not available in the connected ChatGPT account.",
  REASONING_UNAVAILABLE: "The selected reasoning level is not available for this model.",
  PROTOCOL_ERROR: "Codex App Server returned an incompatible response.",
  RESPONSE_FAILED: "ChatGPT did not finish the reply. Check the connection and the account limits.",
  TIMEOUT: "Codex App Server timed out.",
  LOGIN_FAILED: "ChatGPT sign-in failed. Try again; use device-code sign-in if needed.",
  LOGIN_EXPIRED: "The sign-in window expired. Start signing in again.",
});

/** Russian texts for every code: `CodexError.useMessages(RU_CODEX_MESSAGES)` at startup. */
export const RU_CODEX_MESSAGES: Readonly<Record<CodexErrorCode, string>> = Object.freeze({
  NOT_CONFIGURED: "Подключение ChatGPT не настроено на сервере.",
  UNAVAILABLE: "Codex App Server недоступен. Проверьте его установку и настройки.",
  SIGN_IN_REQUIRED: "Администратору нужно подключить аккаунт ChatGPT.",
  BUSY: "Дождитесь завершения текущих ответов или входа в ChatGPT.",
  MODEL_UNAVAILABLE: "Выбранная модель недоступна в подключённом аккаунте ChatGPT.",
  REASONING_UNAVAILABLE: "Выбранный уровень рассуждений недоступен для этой модели.",
  PROTOCOL_ERROR: "Codex App Server вернул несовместимый ответ.",
  RESPONSE_FAILED: "ChatGPT не завершил ответ. Проверьте подключение и лимиты аккаунта.",
  TIMEOUT: "Время ожидания Codex App Server истекло.",
  LOGIN_FAILED: "Не удалось войти в ChatGPT. Повторите вход; при необходимости используйте вход по коду.",
  LOGIN_EXPIRED: "Время для входа истекло. Начните вход заново.",
});

let messages: Readonly<Record<CodexErrorCode, string>> = EN_CODEX_MESSAGES;

/** `message` is user-facing text for `code`; switch its language with `useMessages`. */
export class CodexError extends Error {
  constructor(readonly code: CodexErrorCode) { super(messages[code]); this.name = "CodexError"; }

  /** Replace texts for some or all codes (process-wide); missing codes keep English. */
  static useMessages(overrides: Partial<Record<CodexErrorCode, string>>): void {
    messages = Object.freeze({ ...EN_CODEX_MESSAGES, ...overrides });
  }
}
export const CODEX_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
export const CODEX_REASONING_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;

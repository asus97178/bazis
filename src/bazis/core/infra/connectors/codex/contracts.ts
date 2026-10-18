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

/** Russian texts for every code; `runApp({ language: "ru" })` turns them on. */
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

const CODEX_LANGUAGES = { en: EN_CODEX_MESSAGES, ru: RU_CODEX_MESSAGES } as const;
let language: Readonly<Record<CodexErrorCode, string>> = EN_CODEX_MESSAGES;
let own: Partial<Record<CodexErrorCode, string>> = {};
let messages: Readonly<Record<CodexErrorCode, string>> = EN_CODEX_MESSAGES;

/**
 * @internal `runApp({ language })` sets the language of the texts. It is
 * process-wide, like the texts themselves: the last started application wins.
 */
export function useCodexLanguage(name: keyof typeof CODEX_LANGUAGES): void {
  language = CODEX_LANGUAGES[name];
  messages = Object.freeze({ ...language, ...own });
}

/** `message` is user-facing text for `code`, in the language of `runApp({ language })`. */
export class CodexError extends Error {
  constructor(readonly code: CodexErrorCode) { super(messages[code]); this.name = "CodexError"; }

  /**
   * Own texts for some or all codes (process-wide), on top of the application
   * language; missing codes keep it. `useMessages({})` drops own texts.
   */
  static useMessages(overrides: Partial<Record<CodexErrorCode, string>>): void {
    own = { ...overrides };
    messages = Object.freeze({ ...language, ...own });
  }
}
export const CODEX_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
export const CODEX_REASONING_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;

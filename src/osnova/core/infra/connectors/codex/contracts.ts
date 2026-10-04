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
const messages = {
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
} as const;
export class CodexError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "CodexError"; }
}
export const CODEX_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
export const CODEX_REASONING_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;

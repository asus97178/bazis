/** Instance data that conditions and step inputs read. */
export interface InstanceData {
  readonly input: Readonly<Record<string, unknown>>;
  readonly vars: Readonly<Record<string, unknown>>;
  readonly nodes: Readonly<Record<string, unknown>>;
}

/** `$input.amount`, `$vars.payment.id`, `$nodes.Pay.paymentId`. */
export const DATA_PATH = /^\$(input|vars|nodes)((\.[A-Za-z_][A-Za-z0-9_]*)+)$/;

/** `true` if the value is a path to instance data. */
export function isPath(value: unknown): value is string {
  return typeof value === "string" && DATA_PATH.test(value);
}

/** The value at a path, or `undefined`. Only own keys are read, never `__proto__` and the like. */
export function readPath(data: InstanceData, path: string): unknown {
  const match = DATA_PATH.exec(path);
  if (!match) return undefined;
  let current: unknown = data[match[1] as keyof InstanceData];
  for (const key of match[2]!.slice(1).split(".")) {
    if (typeof current !== "object" || current === null || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * A step input: a path string becomes the instance value, objects and lists are
 * resolved deeply, anything else is a literal. A missing value becomes `null`.
 */
export function resolveInput(value: unknown, data: InstanceData): unknown {
  if (isPath(value)) return readPath(data, value) ?? null;
  if (Array.isArray(value)) return value.map((item) => resolveInput(item, data));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveInput(item, data)]));
  }
  return value;
}

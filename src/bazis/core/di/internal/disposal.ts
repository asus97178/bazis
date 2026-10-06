const symbolDispose = Symbol.dispose as symbol | undefined;
const symbolAsyncDispose = Symbol.asyncDispose as symbol | undefined;

export async function disposeTracked(disposables: readonly unknown[]): Promise<void> {
  const errors: unknown[] = [];
  for (let index = disposables.length - 1; index >= 0; index -= 1) {
    const instance = disposables[index];
    try {
      await disposeOne(instance);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Service disposal finished with errors.");
  }
}

async function disposeOne(instance: unknown): Promise<void> {
  if (!instance || (typeof instance !== "object" && typeof instance !== "function")) {
    return;
  }

  const value = instance as Record<PropertyKey, unknown>;

  const asyncBySymbol =
    symbolAsyncDispose && typeof value[symbolAsyncDispose] === "function"
      ? (value[symbolAsyncDispose] as () => Promise<void>)
      : undefined;
  if (asyncBySymbol) {
    await asyncBySymbol.call(instance);
    return;
  }

  const asyncByName =
    typeof value.disposeAsync === "function" ? (value.disposeAsync as () => Promise<void>) : undefined;
  if (asyncByName) {
    await asyncByName.call(instance);
    return;
  }

  const syncBySymbol =
    symbolDispose && typeof value[symbolDispose] === "function"
      ? (value[symbolDispose] as () => void)
      : undefined;
  if (syncBySymbol) {
    syncBySymbol.call(instance);
    return;
  }

  const syncByName = typeof value.dispose === "function" ? (value.dispose as () => unknown) : undefined;
  if (syncByName) {
    await Promise.resolve(syncByName.call(instance));
  }
}

import type { DatabaseProvider } from "./types";

const DEFAULT_MAX_PARAMETERS_PER_COMMAND = 900;

export function maxRowsPerInsert(provider: DatabaseProvider, columnsPerRow: number): number {
  const maxParameters = positiveInteger(provider.limits?.maxParametersPerCommand, DEFAULT_MAX_PARAMETERS_PER_COMMAND);
  const safeColumnsPerRow = Math.max(1, Math.floor(columnsPerRow));
  const maxRowsByParams = Math.max(1, Math.floor(maxParameters / safeColumnsPerRow));
  const providerRows = optionalPositiveInteger(provider.limits?.maxRowsPerInsert);
  return providerRows === undefined ? maxRowsByParams : Math.max(1, Math.min(providerRows, maxRowsByParams));
}

export function maxParametersPerInList(provider: DatabaseProvider): number {
  const maxParameters = positiveInteger(provider.limits?.maxParametersPerCommand, DEFAULT_MAX_PARAMETERS_PER_COMMAND);
  const maxInList = positiveInteger(provider.limits?.maxParametersPerInList, maxParameters);
  return Math.max(1, Math.min(maxInList, maxParameters));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const parsed = optionalPositiveInteger(value);
  return parsed ?? fallback;
}

function optionalPositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

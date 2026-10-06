import { BadRequestError } from "../Errors/HttpError";

/** Primitive conversion targets for query/header/route values. */
export type ValueType = "string" | "int" | "number" | "bool";

/** Sentinel: conversion failed (distinguishable from any valid value). */
export const INVALID: unique symbol = Symbol("invalid");

const INT_PATTERN = /^-?\d+$/;

/** Converts a raw string; returns INVALID instead of throwing (hot path). */
export function tryConvert(raw: string, type: ValueType): string | number | boolean | typeof INVALID {
  switch (type) {
    case "string":
      return raw;
    case "int": {
      if (!INT_PATTERN.test(raw)) {
        return INVALID;
      }
      const value = Number(raw);
      return Number.isSafeInteger(value) ? value : INVALID;
    }
    case "number": {
      if (raw === "") {
        return INVALID;
      }
      const value = Number(raw);
      return Number.isFinite(value) ? value : INVALID;
    }
    case "bool":
      if (raw === "true" || raw === "1") {
        return true;
      }
      if (raw === "false" || raw === "0") {
        return false;
      }
      return INVALID;
  }
}

/** Converts or throws 400 with the parameter name in the message. */
export function convertOr400(raw: string, type: ValueType, parameterName: string): string | number | boolean {
  const value = tryConvert(raw, type);
  if (value === INVALID) {
    throw new BadRequestError(`Parameter "${parameterName}" must be of type ${type}, got: "${raw}"`);
  }
  return value;
}

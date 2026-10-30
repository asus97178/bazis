import { ISO_DURATION } from "./nodeKinds";

/** Milliseconds of an ISO 8601 duration without months and years (`P2D`, `PT1H30M`); `undefined` if it is not one. */
export function durationMs(value: string): number | undefined {
  const match = ISO_DURATION.exec(value);
  if (!match) return undefined;
  const number = (part: string | undefined) => (part === undefined ? 0 : Number.parseInt(part, 10));
  const weeks = number(match[1]), days = number(match[2]), hours = number(match[4]), minutes = number(match[5]), seconds = number(match[6]);
  return ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

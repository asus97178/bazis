/** A parsed five-field cron expression, evaluated in UTC. */
export interface CronSchedule {
  /** Whether the expression fires at this minute. */
  matches(date: Date): boolean;
  /** The first minute after `after` when it fires; `undefined` if none within five years. */
  next(after: Date): Date | undefined;
}

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;

const MINUTE = 60_000;

/**
 * Parses `minute hour day-of-month month day-of-week` with `*`, numbers,
 * ranges `a-b`, steps `/n` and lists `a,b`. Day of week 0 and 7 are Sunday.
 * When both day fields are restricted, either one matching is enough, as in
 * classic cron. Returns `undefined` for an invalid expression.
 */
export function parseCron(expression: string): CronSchedule | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const sets: Set<number>[] = [];
  for (const [index, part] of parts.entries()) {
    const set = field(part, FIELDS[index]!.min, FIELDS[index]!.max);
    if (set === undefined) return undefined;
    sets.push(set);
  }
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.has(7)) weekdays.add(0);
  const daysRestricted = parts[2] !== "*";
  const weekdaysRestricted = parts[4] !== "*";

  const dayMatches = (date: Date): boolean => {
    const day = days.has(date.getUTCDate());
    const weekday = weekdays.has(date.getUTCDay());
    return daysRestricted && weekdaysRestricted ? day || weekday : day && weekday;
  };

  const matches = (date: Date): boolean =>
    minutes.has(date.getUTCMinutes()) && hours.has(date.getUTCHours()) && months.has(date.getUTCMonth() + 1) && dayMatches(date);

  return {
    matches,
    next(after: Date): Date | undefined {
      const limit = after.getTime() + 5 * 366 * 24 * 60 * MINUTE;
      const date = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE);
      while (date.getTime() <= limit) {
        if (!months.has(date.getUTCMonth() + 1)) {
          date.setUTCMonth(date.getUTCMonth() + 1, 1);
          date.setUTCHours(0, 0, 0, 0);
        } else if (!dayMatches(date)) {
          date.setUTCDate(date.getUTCDate() + 1);
          date.setUTCHours(0, 0, 0, 0);
        } else if (!hours.has(date.getUTCHours())) {
          date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0);
        } else if (!minutes.has(date.getUTCMinutes())) {
          date.setTime(date.getTime() + MINUTE);
        } else {
          return date;
        }
      }
      return undefined;
    },
  };
}

function field(text: string, min: number, max: number): Set<number> | undefined {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (!match) return undefined;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    let from = min, to = max;
    if (match[1] !== "*") {
      const [a, b] = match[1]!.split("-").map(Number) as [number, number | undefined];
      from = a;
      to = b ?? (match[2] === undefined ? a : max);
    }
    if (step < 1 || from < min || to > max || from > to) return undefined;
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out;
}

/** A parsed five-field cron expression, evaluated in UTC or in a time zone. */
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
const DAY_MINUTES = 24 * 60;
/** Clock changes are never longer than this: a day is skipped up to here, the rest hour by hour. */
const CLOCK_CHANGE_MINUTES = 3 * 60;

const formats = new Map<string, Intl.DateTimeFormat>();

function formatOf(timezone: string): Intl.DateTimeFormat {
  let format = formats.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formats.set(timezone, format);
  }
  return format;
}

/** Whether this is an IANA time zone: `Europe/Moscow`, `UTC`. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  try {
    formatOf(value);
    return true;
  } catch {
    return false;
  }
}

/** How far the clocks of the zone are ahead of UTC at this moment, in milliseconds. */
function offsetOf(timezone: string | undefined, time: number): number {
  if (timezone === undefined) return 0;
  const parts: Record<string, number> = {};
  for (const { type, value } of formatOf(timezone).formatToParts(time)) parts[type] = Number(value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(time / 1000) * 1000;
}

/**
 * Parses `minute hour day-of-month month day-of-week` with `*`, numbers,
 * ranges `a-b`, steps `/n` and lists `a,b`. Day of week 0 and 7 are Sunday.
 * When both day fields are restricted, either one matching is enough, as in
 * classic cron. Returns `undefined` for an invalid expression or time zone.
 *
 * With a `timezone` the fields are read on its clocks. A schedule with a set
 * hour fires once a day whatever the clocks do: a time skipped when they go
 * forward fires right after the change, a time repeated when they go back fires
 * the first time only. A schedule with `*` in the hour simply follows the clocks.
 */
export function parseCron(expression: string, timezone?: string): CronSchedule | undefined {
  if (timezone !== undefined && !isTimeZone(timezone)) return undefined;
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
  const hourSet = parts[1] !== "*";

  /** The date part of a time on the clocks of the zone, kept in the UTC fields of a `Date`. */
  const dayMatches = (clock: Date): boolean => {
    const day = days.has(clock.getUTCDate());
    const weekday = weekdays.has(clock.getUTCDay());
    return months.has(clock.getUTCMonth() + 1) && (daysRestricted && weekdaysRestricted ? day || weekday : day && weekday);
  };

  const clockMatches = (clock: Date): boolean => minutes.has(clock.getUTCMinutes()) && hours.has(clock.getUTCHours()) && dayMatches(clock);

  /** Whether the clocks show this time for the second time: they went back a moment ago. */
  const repeated = (time: number, offset: number): boolean => {
    const before = offsetOf(timezone, time - CLOCK_CHANGE_MINUTES * MINUTE);
    if (before <= offset) return false;
    const first = time - (before - offset);
    return offsetOf(timezone, first) === before;
  };

  /** When the clocks jumped forward between two moments, if a firing fell into the skipped time. */
  const skippedFiring = (from: number, to: number): number | undefined => {
    const before = offsetOf(timezone, from);
    const after = offsetOf(timezone, to);
    if (after <= before) return undefined;
    let low = from;
    let high = to;
    while (high - low > MINUTE) {
      const middle = Math.floor((low + high) / 2 / MINUTE) * MINUTE;
      if (offsetOf(timezone, middle) === before) low = middle;
      else high = middle;
    }
    for (let clock = high + before; clock < high + after; clock += MINUTE) {
      if (clockMatches(new Date(clock))) return high;
    }
    return undefined;
  };

  return {
    matches(date: Date): boolean {
      const offset = offsetOf(timezone, date.getTime());
      if (!clockMatches(new Date(date.getTime() + offset))) return false;
      return !(hourSet && timezone !== undefined && repeated(Math.floor(date.getTime() / MINUTE) * MINUTE, offset));
    },
    next(after: Date): Date | undefined {
      const limit = after.getTime() + 5 * 366 * DAY_MINUTES * MINUTE;
      let time = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
      let previous = time - MINUTE;
      while (time <= limit) {
        if (hourSet && timezone !== undefined) {
          const skipped = skippedFiring(previous, time);
          if (skipped !== undefined) return new Date(skipped);
        }
        previous = time;
        const offset = offsetOf(timezone, time);
        const clock = new Date(time + offset);
        const minutesOfDay = clock.getUTCHours() * 60 + clock.getUTCMinutes();
        if (!dayMatches(clock)) {
          // Close to midnight hour by hour: the day may be shorter than its clocks say.
          const left = DAY_MINUTES - minutesOfDay;
          time += (timezone === undefined ? left : left > CLOCK_CHANGE_MINUTES ? left - CLOCK_CHANGE_MINUTES : 60 - clock.getUTCMinutes()) * MINUTE;
        } else if (!hours.has(clock.getUTCHours())) {
          time += (60 - clock.getUTCMinutes()) * MINUTE;
        } else if (!minutes.has(clock.getUTCMinutes())) {
          time += MINUTE;
        } else if (hourSet && timezone !== undefined && repeated(time, offset)) {
          time += MINUTE;
        } else {
          return new Date(time);
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

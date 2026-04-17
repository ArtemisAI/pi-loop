/**
 * 5-field cron parser and next-run calculator.
 * All evaluation is in the user's local timezone.
 *
 * Format: minute hour day-of-month month day-of-week
 */

interface CronField {
  values: Set<number>;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const FIELD_RANGES: [number, number][] = [
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day of month
  [1, 12],   // month
  [0, 6],    // day of week (0=Sunday)
];

function parseField(field: string, min: number, max: number): CronField | null {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (step < 1) return null;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else {
      const dashMatch = range.match(/^(\d+)-(\d+)$/);
      if (dashMatch) {
        const lo = parseInt(dashMatch[1], 10);
        const hi = parseInt(dashMatch[2], 10);
        if (lo < min || hi > max || lo > hi) return null;
        for (let i = lo; i <= hi; i += step) values.add(i);
      } else {
        const val = parseInt(range, 10);
        if (isNaN(val) || val < min || val > max) return null;
        values.add(val);
      }
    }
  }

  return values.size > 0 ? { values } : null;
}

export function parseCronExpression(cron: string): ParsedCron | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const fields: CronField[] = [];
  for (let i = 0; i < 5; i++) {
    const field = parseField(parts[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1]);
    if (!field) return null;
    fields.push(field);
  }

  return {
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
  };
}

/**
 * Compute next cron run after `from`. Returns null if no match within 1 year.
 */
export function computeNextCronRun(parsed: ParsedCron, from: Date): Date | null {
  const d = new Date(from.getTime());
  // Start from the next minute
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (d < limit) {
    if (!parsed.month.values.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    if (!parsed.dayOfMonth.values.has(d.getDate()) ||
        !parsed.dayOfWeek.values.has(d.getDay())) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    if (!parsed.hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!parsed.minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }

    return d;
  }

  return null;
}

/**
 * Convenience: parse cron string and compute next run in epoch ms.
 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const parsed = parseCronExpression(cron);
  if (!parsed) return null;
  const next = computeNextCronRun(parsed, new Date(fromMs));
  return next ? next.getTime() : null;
}

/**
 * Convert cron expression to human-readable string.
 */
export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [min, hour, dom, mon, dow] = parts;

  // Every N minutes
  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = parseInt(everyMinMatch[1], 10);
    return n === 1 ? "every minute" : `every ${n} minutes`;
  }

  // Every N hours
  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (min === "0" && everyHourMatch && dom === "*" && mon === "*" && dow === "*") {
    const n = parseInt(everyHourMatch[1], 10);
    return n === 1 ? "every hour" : `every ${n} hours`;
  }

  // Every N days (or bare * which is equivalent to */1)
  if (min === "0" && hour === "0" && mon === "*" && dow === "*") {
    if (dom === "*") return "every day at midnight";
    const everyDayMatch = dom.match(/^\*\/(\d+)$/);
    if (everyDayMatch) {
      const n = parseInt(everyDayMatch[1], 10);
      return n === 1 ? "every day at midnight" : `every ${n} days at midnight`;
    }
  }

  // Specific time
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `daily at ${h12}:${m.toString().padStart(2, "0")} ${period}`;
  }

  return cron;
}

/**
 * Convert a human interval string (e.g. "5m", "2h", "1d") to a cron expression.
 */
export function intervalToCron(interval: string): string | null {
  const match = interval.match(/^(\d+)([smhd])$/);
  if (!match) return null;

  let n = parseInt(match[1], 10);
  const unit = match[2];

  if (n <= 0) return null;

  switch (unit) {
    case "s":
      // Cron minimum is 1 minute; round up
      n = Math.max(1, Math.ceil(n / 60));
      return `*/${n} * * * *`;
    case "m":
      if (n <= 59) return `*/${n} * * * *`;
      // Round to hours
      const hours = Math.max(1, Math.round(n / 60));
      return `0 */${hours} * * *`;
    case "h":
      if (n <= 23) return `0 */${n} * * *`;
      return `0 0 */${Math.ceil(n / 24)} * *`;
    case "d":
      return `0 0 */${n} * *`;
    default:
      return null;
  }
}

/**
 * Compute the gap between consecutive fires for a cron expression (in ms).
 * Used for jitter calculation.
 */
export function cronGapMs(cron: string, fromMs: number): number | null {
  const first = nextCronRunMs(cron, fromMs);
  if (first === null) return null;
  const second = nextCronRunMs(cron, first);
  if (second === null) return null;
  return second - first;
}

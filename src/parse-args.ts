/**
 * /loop argument parser.
 *
 * Priority:
 * 1. Leading interval token: "5m check the deploy"
 * 2. Trailing "every" clause: "check the deploy every 20m"
 * 3. Default 10m
 */

export interface ParsedLoopArgs {
  interval: string;
  prompt: string;
}

const INTERVAL_RE = /^\d+[smhd]$/;
const TRAILING_EVERY_RE = /\s+every\s+(\d+)\s*([smhd]|seconds?|minutes?|hours?|days?)\s*$/i;

const UNIT_MAP: Record<string, string> = {
  s: "s", second: "s", seconds: "s",
  m: "m", minute: "m", minutes: "m",
  h: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
};

export function parseLoopArgs(args: string): ParsedLoopArgs | null {
  const trimmed = args.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/);

  // Rule 1: Leading interval token
  if (tokens.length >= 2 && INTERVAL_RE.test(tokens[0])) {
    return {
      interval: tokens[0],
      prompt: tokens.slice(1).join(" "),
    };
  }

  // Rule 2: Trailing "every" clause
  const everyMatch = trimmed.match(TRAILING_EVERY_RE);
  if (everyMatch) {
    const n = everyMatch[1];
    const unitRaw = everyMatch[2].toLowerCase();
    const unit = UNIT_MAP[unitRaw];
    if (unit) {
      const prompt = trimmed.slice(0, everyMatch.index).trim();
      if (prompt) {
        return {
          interval: `${n}${unit}`,
          prompt,
        };
      }
    }
  }

  // Rule 3: Default 10m
  return {
    interval: "10m",
    prompt: trimmed,
  };
}

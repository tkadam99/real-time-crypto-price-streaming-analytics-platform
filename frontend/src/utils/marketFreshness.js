export function marketFreshness(timestamp, now = Date.now()) {
  if (typeof timestamp !== "string" || timestamp.trim() === "") return "unknown";
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  if (!match) return "unknown";
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    return "unknown";
  }
  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime) || !Number.isFinite(now) || eventTime > now) return "unknown";
  const subMillisecond = Number(fraction.padEnd(9, "0").slice(3));
  const age = (now - eventTime) * 1_000_000 - subMillisecond;
  if (age < 0) return "unknown";
  if (age <= 30_000 * 1_000_000) return "fresh";
  if (age <= 120_000 * 1_000_000) return "delayed";
  return "stale";
}

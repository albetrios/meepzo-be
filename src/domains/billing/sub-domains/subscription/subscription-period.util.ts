/**
 * Advances a date by a whole number of months, clamping the day to the last valid day of the
 * target month so month-end start dates never overflow into the following month (e.g. Jan 31 + 1
 * month yields Feb 28/29, not Mar 3). Used to derive a subscription's local `current_period_end`
 * from its start date and billing cycle; for Stripe-backed subscriptions the authoritative period
 * end arrives via webhook and overwrites this value. Works in UTC (the `getUTC*` / `setUTC*`
 * methods), so the result never depends on the host's time zone.
 */
export function addMonths({ base, months }: { base: Date; months: number }): Date {
  const result = new Date(base);
  const dayOfMonth = result.getUTCDate();
  // Shift the month from the 1st so the intermediate date can never overflow, then clamp the day.
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return result;
}

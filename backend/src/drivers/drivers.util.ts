import { ModuleRef } from '@nestjs/core';
import { haversineKm } from '../common/geo.util';

/**
 * Resolve a service owned by another module without a compile-time dependency (the owner may not be built yet).
 * `file` is relative to this folder (e.g. '../orders/orders.service'). Returns null when unavailable.
 */
export function lazyService<T = any>(ref: ModuleRef, file: string, className: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    const cls = mod?.[className];
    return cls ? (ref.get(cls, { strict: false }) as T) : null;
  } catch {
    return null;
  }
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  return `+${d.slice(0, 1)} ***-***-${d.slice(-4)}`;
}

export function maskAccount(v?: string | null): string | null {
  return v ? `****${v.slice(-4)}` : null;
}

/** A SIN for the courier's own screen: everything hidden except the last four digits (***-**5-678). Older records only kept three. */
export function maskSin(t?: { sinLast4?: string | null; sinLast3?: string | null } | null): string | null {
  if (t?.sinLast4 && /^\d{4}$/.test(t.sinLast4)) return `***-**${t.sinLast4[0]}-${t.sinLast4.slice(1)}`;
  return t?.sinLast3 ? `***-***-${t.sinLast3}` : null;
}

export function shortName(first?: string | null, last?: string | null): string {
  return `${first ?? ''} ${last ? last[0] + '.' : ''}`.trim();
}

export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  return haversineKm(aLat, aLng, bLat, bLng) * 1000;
}

/** Start of the local day (or ISO week, Monday) in a timezone, as a UTC Date. */
export function tzStart(unit: 'day' | 'week', now = new Date(), tz = 'America/Toronto'): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p: Record<string, string> = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const localAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  let day = Date.UTC(+p.year, +p.month - 1, +p.day);
  if (unit === 'week') {
    const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
    day -= dow * 86400000;
  }
  return new Date(day - offset);
}

export const todayStr = () => new Date().toISOString().slice(0, 10);
export const daysUntil = (dateStr: string, from = new Date()) =>
  Math.floor((new Date(dateStr + 'T23:59:59Z').getTime() - from.getTime()) / 86400000);

/** 1234 -> "1.2k", 1_250_000 -> "1.3M", null -> "–". */
export function formatCount(n: number | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  if (n < 1000) return String(n);
  if (n < 999_950) return `${oneDecimal(n / 1000)}k`;
  return `${oneDecimal(n / 1_000_000)}M`;
}

function oneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** "Big  Tits " -> "big_tits" (e621-style tag token). */
export function tagToken(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

/** 65 -> "1:05". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** "pale-girls" -> "Pale girls" (niche id shown as a name). */
export function formatNicheName(id: string): string {
  const text = id.trim().replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

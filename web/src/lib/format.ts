export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "" : n.toLocaleString("en-US"));

/** 台北時間 8 碼日期 */
export function taipeiDate(d = new Date()): number {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return Number(s.replaceAll("-", ""));
}

export const ymdToIso = (n: number) => { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`; };

export function timeTW(iso: string | null | undefined, withDate = true): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", hour12: false, hour: "2-digit", minute: "2-digit",
    ...(withDate ? { month: "2-digit", day: "2-digit" } : {}),
  }).format(new Date(iso));
}

/** 原圖剩幾天（保存 90 天） */
export function retentionLeft(createdAt: string, deletedAt?: string | null): number {
  if (deletedAt) return -1;
  return 90 - Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400_000);
}

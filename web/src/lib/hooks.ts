"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 讀資料並定時重新整理（預設 20 秒）；回傳 reload 給操作後立即更新 */
export function useLive<T>(fetcher: () => Promise<T>, deps: unknown[], intervalMs = 20_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(fetcher);
  useLayoutEffect(() => { ref.current = fetcher; });
  const reload = useCallback(async () => {
    try { setData(await ref.current()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    reload();
    if (!intervalMs) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") reload(); }, intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload };
}

/** supabase 查詢結果：有錯就丟出來（沒有產生資料庫型別檔，結果型別由呼叫端標註） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function must<T = any>(r: { data: unknown; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

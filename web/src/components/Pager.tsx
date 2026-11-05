"use client";
// 長清單分頁：每頁固定筆數，下方「上一頁／下一頁」。resetKey 改變（例如換篩選條件）時回到第 1 頁。
import { useState } from "react";

export function usePaged<T>(items: T[], size: number, resetKey: unknown = null) {
  const [state, setState] = useState<{ key: unknown; page: number }>({ key: resetKey, page: 0 });
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = state.key === resetKey ? Math.min(state.page, pages - 1) : 0;
  const go = (p: number) => setState({ key: resetKey, page: Math.max(0, Math.min(p, pages - 1)) });
  const rows = items.slice(page * size, page * size + size);
  const offset = page * size;
  const pager = items.length > size ? (
    <div className="pager">
      <button className="btn small" type="button" disabled={page === 0} onClick={() => go(page - 1)}>上一頁</button>
      <span className="note">第 {page + 1}／{pages} 頁・共 {items.length} 筆</span>
      <button className="btn small" type="button" disabled={page >= pages - 1} onClick={() => go(page + 1)}>下一頁</button>
    </div>
  ) : null;
  return { rows, pager, offset };
}

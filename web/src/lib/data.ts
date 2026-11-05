"use client";
import type { ReceiptValues } from "@shared/rules.ts";
import { supabaseBrowser } from "./supabase/client";
import { must } from "./hooks";

export interface Receipt {
  id: string; upload_id: string; page_ids: string[]; entry_index: number;
  status: "auto" | "review" | "reviewed" | "skipped"; reasons: string[];
  ai_values: ReceiptValues; current_values: ReceiptValues;
  customer_code: string; customer_name: string; amount: number | null; summary: string; scan_date: number;
  released_by: string | null; released_at: string | null; export_id: string | null; created_at: string;
}
export interface PageRow {
  id: string; upload_id: string; page_no: number; image_path: string; status: string; page_type: string | null;
  created_at: string; image_deleted_at: string | null; error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
}
export interface Upload { id: string; file_name: string; page_count: number; status: string; scan_date: number; created_at: string; finalized_at: string | null }

/** 收款加上來源頁與上傳檔資訊 */
export async function withSources<T extends { page_ids: string[]; upload_id: string }>(rows: T[]) {
  const sb = supabaseBrowser();
  const pageIds = [...new Set(rows.flatMap((r) => r.page_ids))];
  const uploadIds = [...new Set(rows.map((r) => r.upload_id))];
  const [pages, uploads] = await Promise.all([
    pageIds.length ? sb.from("pages").select("id, upload_id, page_no, image_path, created_at, image_deleted_at, page_type, result").in("id", pageIds) : { data: [], error: null },
    uploadIds.length ? sb.from("uploads").select("id, file_name, scan_date, created_at").in("id", uploadIds) : { data: [], error: null },
  ]);
  const pm = new Map<string, PageRow>(must<PageRow[]>(pages).map((p) => [p.id, p]));
  const um = new Map<string, Upload>(must<Upload[]>(uploads).map((u) => [u.id, u]));
  return rows.map((r) => {
    const ps = r.page_ids.map((id) => pm.get(id)).filter(Boolean) as PageRow[];
    const up = um.get(r.upload_id);
    return { ...r, pages: ps, upload: up, source: `${up?.file_name ?? ""} 第 ${ps.map((p) => p.page_no).join("、")} 頁` };
  });
}

let customerCache: Promise<Map<string, string>> | null = null;
/** 客戶主檔（編號 → 名稱），整份載入一次 */
export function loadCustomers(force = false): Promise<Map<string, string>> {
  if (!customerCache || force) {
    customerCache = (async () => {
      const sb = supabaseBrowser();
      const all: { code: string; name: string }[] = [];
      for (let from = 0; ; from += 1000) {
        const chunk = must(await sb.from("customers").select("code, name").order("code").range(from, from + 999));
        all.push(...chunk);
        if (chunk.length < 1000) break;
      }
      return new Map(all.map((c) => [c.code, c.name]));
    })();
  }
  return customerCache;
}

export async function signedUrl(path: string): Promise<string | null> {
  const { data } = await supabaseBrowser().storage.from("scans").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

export const METHOD_ZH = { cash: "收現", check: "收支票", transfer: "匯款", unknown: "不明" } as const;
export const PAGE_TYPE_ZH: Record<string, string> = { delivery_note: "送貨單", statement: "對帳單", not_a_document: "非單據頁" };

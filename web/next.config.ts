import path from "node:path";
import type { NextConfig } from "next";

// 內部系統：每頁都要登入、資料即時，所以不開 Cache Components（一律動態渲染）。
// 規則、Excel 格式與雲端辨識程式共用 ../supabase/functions/_shared，所以把 turbopack 根目錄設在 repo 根目錄。
const nextConfig: NextConfig = {
  turbopack: { root: path.join(import.meta.dirname, "..") },
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
};

export default nextConfig;

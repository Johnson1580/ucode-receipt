// 每個請求先更新 Supabase 登入狀態（token 快過期時換新），沒登入就導到登入頁。
// 這裡只做初步判斷，真正的權限檢查在頁面（requireMe）與資料庫（RLS）。
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/reset-password", "/auth/callback"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // getClaims 在本機驗證登入憑證的簽章（不用每次連到 Supabase 問），token 快過期時才會連線換新
  const { data } = await sb.auth.getClaims();
  const user = data?.claims?.sub;
  const path = request.nextUrl.pathname;
  if (!user && !PUBLIC.some((p) => path.startsWith(p)) && !path.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|logo.png|icons/).*)"],
};

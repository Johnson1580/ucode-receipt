import { Shell } from "@/components/Shell";
import { requireMe } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe();
  return <Shell me={me}>{children}</Shell>;
}

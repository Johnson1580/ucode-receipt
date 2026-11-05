// 附件一第三節角色表：「編」＝可操作、「看」＝唯讀
import type { Role } from "./auth";

export const can = {
  review: (r: Role[]) => r.some((x) => ["owner", "accountant", "reviewer"].includes(x)),
  export: (r: Role[]) => r.some((x) => ["owner", "accountant"].includes(x)),
  settings: (r: Role[]) => r.includes("owner"),
};

export const ROLE_ZH: Record<Role, string> = { owner: "老闆（系統管理）", accountant: "會計", reviewer: "複核人員" };

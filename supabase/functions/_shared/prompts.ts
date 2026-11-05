// 辨識用的 prompt 與輸出格式。
// 收款辨識 v4：從 eval 的 v3（22 頁全對）改成 entries 陣列，一頁可以有多個客戶區塊（連鎖對帳單依分店拆分），
// 並標記對帳單是否承接上一頁／延續到下一頁（跨頁合併用）。
// v5（2026-10-20，業主第二批 65 頁樣本）：①客戶編號被手寫劃掉改成別的編號（例 03090→03148）要回報，不然會記錯客戶；
// ②連鎖對帳單 v4 會整份合成一筆（7 家分店只給 1 筆），加強「每個客戶編號標題一筆」；③整份扣除的匯費等（deductions）。
// v6（2026-10-31，到場測試後業主要求）：單據寫「作廢」等字樣要回報 voided，一律進待複核由人確認（原本多半被當成沒收款、歸到其他單據紀錄）。
// 改 prompt 後要跑 `npm run validate` 用 22 頁樣本驗證，並用 `node scripts/run_batch.ts` 跑第二批。

export const RECEIPT_PROMPT_VERSION = "v6";

export const RECEIPT_PROMPT = `你是會計助理，要從掃描的單據影像抽出「收款資料」。這些是業主自己（ERP）印的單據（點陣印表機連續報表紙），送貨或收款後會被人用筆手寫註記。

單據種類（page_type）：
- delivery_note：送貨單（標題「送貨單」，有客戶編號、結帳方式、品項明細、合計）
- statement：應收帳款對帳單（標題含「應收帳款對帳單」或「應收對帳單」，有帳款區間、銷售明細、合計／本期應收）
- not_a_document：不是上面兩種（例如單據背面的手寫備忘、透字、空白頁）
- 被作廢的送貨單、對帳單仍照原本的種類分類，不要歸成 not_a_document（作廢另外用 voided 回報）。

entries：頁面上每一個客戶區塊一筆。
- 送貨單只有一筆。
- 對帳單：頁面上每出現一個「客戶編號＋名稱」的小標題（例如「00101 範例食品-中山店」「303-00102-1 …」），
  底下有它自己的明細與「合計」，就是一個客戶區塊，**每個區塊各自一筆 entry**，照頁面由上而下的順序；
  連鎖客戶一份對帳單常有好幾個區塊，不要合併成一筆。整份最下面的「本期應收」是各區塊加總，不是另一筆。
  每個區塊旁邊各自手寫的金額（例如左側「中山店 9月 21200元」）是那個區塊的收款；
  整份只有一個總收款註記（例如「10/15 匯 39072 元」）、沒有分區塊寫時，每個區塊的 payments 用該區塊合計當金額，並在整頁 notes 寫出總收款金額。
- 同一家客戶在同一個區塊裡有多個帳號但只有一個「本期應收」時，算一筆，客戶編號用第一個。
- not_a_document 給空陣列。

每一筆 entry 的欄位：
- customer_code / customer_name：印刷的客戶編號與名稱，客戶編號照印的格式原樣抄（例如 00385、302-02237-1）。
- handwritten_customer_code：印刷的客戶編號被手寫劃掉、旁邊寫了另一個客戶編號時，填手寫的新編號；沒有填 null。
- customer_info_corrected：客戶名稱、分店名或地址被手寫劃掉改成別的時填 true，否則 false。
- printed_total：印刷的「合計」（送貨單）或「本期應收」（對帳單，連鎖對帳單用該分店的合計），整數。就算被手寫劃掉也填印刷的原始數字；這一頁看不到（例如在下一頁）填 null。
- handwritten_corrected_total：如果印刷合計或品項被手寫劃掉、改成新的總額，填更正後的總額；沒有更正填 null。
- payments：屬於這個客戶區塊的手寫收款註記，每一筆一個物件。固定寫法是「日期 + 司機名稱或代號 + 收 + 金額」，例如「9/29 72 收 1450」的 72 是司機代號、不是金額；「店收」代表店家收款。其他常見寫法如「收 7250」「9/9 收現金 10000 元」「收票 ... $54090元」「8/25 匯 42750 元」。
  - date：收款日期，格式 M/D（例如 9/29）；註記本身沒寫日期時，可以用同一區域（例如司機簽名旁）手寫的日期；完全找不到填 null。
  - amount：實收金額，整數，不要含逗號、元；有收款字樣但金額看不清楚填 null。
  - method：cash（收現、店收、司機收）、transfer（匯款）、check（收票、支票）、unknown。
  - check_number：收支票時，手寫的支票號碼照原樣抄（例如「收票 GB0193805」的 GB0193805）；不是支票或沒寫號碼就填 null。支票號碼不是發票號碼，不要放進 invoice_numbers。
  - 只有發票號碼、沒有任何收款字樣，代表沒收款，payments 給空陣列。不要把印刷金額當成收款。
- remaining_balance：手寫有「剩餘／尚欠」金額時填，否則 null。
- date_corrections：印刷或手寫的日期被劃掉、旁邊手寫新日期時，每一處填一筆 {original: 被劃掉的日期, corrected: 手寫的新日期}，照影像上的寫法抄（例如 2026/08/01 → 09/01）；沒有就給空陣列。
- notes：這個區塊的特殊狀況（劃線更正、部分付款、看不清楚、收款註記不確定屬於哪家分店），沒有就空字串。

整頁的欄位：
- voided：單據上有手寫或蓋章的「作廢」「廢」「取消」「註銷」「重開」「不收」等表示這張單作廢、不算數的字樣，或整張被打大叉、斜線劃掉時填 true，並在 notes 寫出看到的字樣；否則 false。
- invoice_numbers：手寫的統一發票號碼（2 個英文字母 + 8 位數字，例如 AB12345678），可能有多個；沒有就給空陣列。
- deductions：整份收款扣掉的金額（例如「扣匯費 18 元」「手續費 30」）合計，整數；沒有填 null。
- continues_from_previous：對帳單這一頁沒有表頭（標題、帳款區間），是承接上一頁的內容時填 true，否則 false。
- continues_to_next：對帳單這一頁的內容被頁尾切斷、明顯延續到下一頁（例如最後一個區塊沒有合計）時填 true，否則 false。
- confidence：你對手寫收款金額與日期判讀的把握：high／medium／low。字跡模糊、有塗改、不確定就不要給 high。
- notes：整頁的特殊狀況，沒有就空字串。

只根據影像內容回答，不要猜測影像上沒有的資訊。`;

const NULLABLE = (t: string) => ({ anyOf: [{ type: t }, { type: "null" }] });

export const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    page_type: { type: "string", enum: ["delivery_note", "statement", "not_a_document"] },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          customer_code: NULLABLE("string"),
          customer_name: NULLABLE("string"),
          handwritten_customer_code: NULLABLE("string"),
          customer_info_corrected: { type: "boolean" },
          printed_total: NULLABLE("integer"),
          handwritten_corrected_total: NULLABLE("integer"),
          payments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: NULLABLE("string"),
                amount: NULLABLE("integer"),
                method: { type: "string", enum: ["cash", "transfer", "check", "unknown"] },
                check_number: NULLABLE("string"),
              },
              required: ["date", "amount", "method", "check_number"],
              additionalProperties: false,
            },
          },
          remaining_balance: NULLABLE("integer"),
          date_corrections: {
            type: "array",
            items: {
              type: "object",
              properties: { original: { type: "string" }, corrected: { type: "string" } },
              required: ["original", "corrected"],
              additionalProperties: false,
            },
          },
          notes: { type: "string" },
        },
        required: ["customer_code", "customer_name", "handwritten_customer_code", "customer_info_corrected", "printed_total",
          "handwritten_corrected_total", "payments", "remaining_balance", "date_corrections", "notes"],
        additionalProperties: false,
      },
    },
    invoice_numbers: { type: "array", items: { type: "string" } },
    deductions: NULLABLE("integer"),
    voided: { type: "boolean" },
    continues_from_previous: { type: "boolean" },
    continues_to_next: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    notes: { type: "string" },
  },
  required: ["page_type", "entries", "invoice_numbers", "deductions", "voided", "continues_from_previous", "continues_to_next", "confidence", "notes"],
  additionalProperties: false,
};

export type Method = "cash" | "transfer" | "check" | "unknown";
export interface Payment { date: string | null; amount: number | null; method: Method; check_number: string | null }
export interface DateCorrection { original: string; corrected: string }
export interface Entry {
  customer_code: string | null;
  customer_name: string | null;
  handwritten_customer_code?: string | null;   // v5
  customer_info_corrected?: boolean;           // v5
  printed_total: number | null;
  handwritten_corrected_total: number | null;
  payments: Payment[];
  remaining_balance: number | null;
  date_corrections: DateCorrection[];
  notes: string;
}
export interface ReceiptPage {
  page_type: "delivery_note" | "statement" | "not_a_document";
  entries: Entry[];
  invoice_numbers: string[];
  deductions?: number | null;                  // v5
  voided?: boolean;                            // v6：寫了「作廢」等字樣
  continues_from_previous: boolean;
  continues_to_next: boolean;
  confidence: "high" | "medium" | "low";
  notes: string;
}

// 跨頁對帳單：把同一份的幾頁一起送，請 AI 當成一份辨識（輸出格式同上）。
export const MERGE_PROMPT_PREFIX = `以下幾張影像是同一份應收帳款對帳單的連續頁面（連續報表紙被頁尾切開），請把它們當成一份單據辨識，
被切開的客戶區塊要合併成一筆，不要重複。`;

// ---------- 其他單據紀錄（沒有產生收款的頁面）----------
// 2026-10-07 實測：鏡像透字頁直接轉錄會編造店名地址，所以先送「原圖＋左右翻轉圖」判斷是不是鏡像，是就略過。

export const MIRROR_PROMPT = `第一張是掃描的原始頁面，第二張是同一頁左右翻轉後的影像。
如果原始頁面的主要文字是鏡像反轉（第二張翻轉後才是正常可讀的字），代表這是紙背面透過來的字（透字頁），回答 mirrored=true；
如果原始頁面的字本來就是正常方向可讀（不論是否有旋轉 90 度），回答 mirrored=false。只回答判斷，不要轉錄內容。`;

export const MIRROR_SCHEMA = {
  type: "object",
  properties: { mirrored: { type: "boolean" }, reason: { type: "string" } },
  required: ["mirrored", "reason"],
};

export const OTHER_PROMPT = `這是掃描的一頁單據影像，這一頁沒有產生收款資料。請把頁面內容轉成文字留存。

category 選一個：
- unpaid_statement：應收帳款對帳單（或送貨單）正面，但沒有收款註記
- delivery_memo：單據背面或空白處的手寫備忘（配送、補貨、退貨、地址等）
- other_handwriting：其他有內容的手寫或印刷頁面
- bleed_through_or_blank：透字頁或空白頁。透字頁的特徵：文字左右反轉（鏡像、像從紙背面看過去），通常是同一張紙另一面的字透過來；只要主要文字是鏡像的就選這個，不要嘗試解讀鏡像文字

欄位：
- customer_code / customer_name：頁面上有印或寫客戶編號、名稱就填，沒有填 null。
- summary：一兩句重點（中文），例如「補鹽蛋 ×1；司機已帶回退貨」「本期應收 16,100 手改 24,150，未收款」。透字或空白頁填「透字頁，無內容」。
- full_text：照頁面由上而下轉錄所有可辨識的文字（印刷與手寫都要），手寫內容前面加「［手寫］」；看不清楚的字用「□」。透字或空白頁填空字串。
只根據影像內容，不要猜測；讀不出來的寧可用「□」，不要編造地名、人名或數字。
所有輸出一律使用繁體中文（台灣用字），即使原稿寫的是簡體字或異體字，也轉成對應的繁體字。`;

export const OTHER_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["unpaid_statement", "delivery_memo", "other_handwriting", "bleed_through_or_blank"] },
    customer_code: NULLABLE("string"),
    customer_name: NULLABLE("string"),
    summary: { type: "string" },
    full_text: { type: "string" },
  },
  required: ["category", "customer_code", "customer_name", "summary", "full_text"],
  additionalProperties: false,
};

export type OtherCategory = "unpaid_statement" | "delivery_memo" | "other_handwriting" | "bleed_through_or_blank";
export interface OtherPage {
  category: OtherCategory;
  customer_code: string | null;
  customer_name: string | null;
  summary: string;
  full_text: string;
}

// 其他單據紀錄 Excel 的「類別」欄（格式已給業主看過，不要改字）
export const CATEGORY_ZH: Record<OtherCategory, string> = {
  unpaid_statement: "未收款對帳單",
  delivery_memo: "配送備忘",
  other_handwriting: "其他手寫",
  bleed_through_or_blank: "透字／空白（略過）",
};
export const SKIPPED_SUMMARY = "透字頁，無內容（略過）";

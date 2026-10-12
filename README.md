# 裕信汽車｜零服 UIO 管理系統

售後客戶與車輛查詢儀表板：客戶儀表板、客戶查詢、車輛查詢、售後商機、服務金三角名單，支援縣市地圖下鑽、條件篩選、排序與 Excel 匯出。

## CDP／CRM 功能

總覽 → 客群 → 客戶（客戶 360）→ 商機 → 任務 → 成效，另有銷售顧問工作台（服務金三角 → 業代）與資料管理（匯入、來源、自動化、權限、稽核）。
資料存於 Cloudflare D1（本機為 `.wrangler/state/`，不納入版本控管）；資料模型、遷移與回復、權限與規則說明見 [docs/CDP-CRM.md](docs/CDP-CRM.md)。
驗收：`node scripts/verify-crm.mjs`（使用 ZZTEST- 測試資料，結束後自動清除）。

## 資料與個資

- 本儲存庫**不含任何資料**。`public/data/` 已列入 `.gitignore`，需在本機由 Excel 產生。
- 儀表板只使用**去識別化**資料：車牌、VIN、姓名、電話、Email、地址等欄位都不會進入儀表板，每台車以「識別碼」（例如 `ES-00001`）表示。
- 匯出的 Excel 第一欄是識別碼，可回到地端保留個資的檔案比對。

## 本機執行

需要 Node.js 22.13 以上與 Python 3（openpyxl）。

```bash
npm install
# 由去識別化 Excel 產生 public/data/vehicles.json 與 metadata.json
CRM_SOURCE_XLSX="path/to/UIO客戶數據平台_雲端_去識別化.xlsx" python data-pipeline/build_cloud_dashboard_data.py
npm run dev
```

開啟 http://127.0.0.1:5173 （首次會自動以本機身分登入）。Windows 可直接雙擊 `開啟UIO儀表板.bat`。

> 若個資欄位出現非識別碼的值，轉檔程式會中止，不會輸出資料。

## 地端還原個資（匯出含個資名單）

儀表板本身永遠不含個資。需要聯絡客戶時，在**地端電腦**把匯出的名單補回個資：

1. 儀表板篩選後按「匯出目前結果 Excel」。
2. 把匯出的 Excel 拖曳到 `data-pipeline/還原個資.bat`。
3. 在 `%USERPROFILE%\UIO含個資名單\`（不會被 OneDrive 同步）產生 `…_含個資.xlsx`，完成後自動開啟該資料夾，在識別碼後面加上車牌、VIN、車主、電話、Email、地址、駕駛等欄位。

預設讀取 `OneDrive\桌面\AI參照\地端雲端資料\` 內的地端與雲端檔，可用 `--onprem`、`--cloud` 指定其他位置。
地端檔若沒有識別碼欄，會以列序對應，並先逐列核對兩檔的非個資欄位；一致率不足 99.5% 即中止、不輸出，避免對錯人。

> 含個資的輸出檔請只存放在地端，勿上傳雲端、GitHub 或以通訊軟體傳送（`*.xlsx` 已列入 `.gitignore`）。

## 主要檔案

- `app/page.tsx`：儀表板畫面
- `app/api/vehicles/route.ts`：篩選、統計、排序與 Excel 匯出 API
- `app/taiwan-counties.json`：台灣縣市地圖路徑
- `data-pipeline/`：Excel → JSON 轉檔程式（`build_cloud_dashboard_data.py` 為去識別化版本）與地端還原個資工具（`restore_pii.py`、`還原個資.bat`）

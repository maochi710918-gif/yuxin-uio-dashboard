# 裕信汽車｜零服 UIO 管理系統

售後客戶與車輛查詢儀表板：客戶儀表板、客戶查詢、車輛查詢、售後商機、服務金三角名單，支援縣市地圖下鑽、條件篩選、排序與 Excel 匯出。

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

開啟 http://127.0.0.1:5173 。

> 若個資欄位出現非識別碼的值，轉檔程式會中止，不會輸出資料。

## 主要檔案

- `app/page.tsx`：儀表板畫面
- `app/api/vehicles/route.ts`：篩選、統計、排序與 Excel 匯出 API
- `app/taiwan-counties.json`：台灣縣市地圖路徑
- `data-pipeline/`：Excel → JSON 轉檔程式（`build_cloud_dashboard_data.py` 為去識別化版本）

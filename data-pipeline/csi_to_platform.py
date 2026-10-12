"""地端轉檔：CSI 滿意度 → 平台匯入檔（車牌換成車輛編碼，輸出不含車牌）。

只在地端執行。讀取 CSI 資料（records.js 或同欄位的 CSV／Excel）與地端保留個資的 UIO 檔，
依車牌找到車輛編碼；對應方式與「還原個資」工具相同（識別碼欄或經核對的列序）。

用法：
  python csi_to_platform.py records.js 輸出.csv --onprem 地端檔.xlsx --cloud 雲端檔.xlsx --units 轉檔資料夾/units.csv
"""
import argparse
import csv
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import restore_pii as restore  # noqa: E402  (shared on-prem matching with alignment check)

HEADER = ["問卷編碼", "車輛編碼", "客戶編碼", "問卷月份", "進廠日", "單位編碼", "服專編碼", "技師編碼", "交車方式", "首次進廠", "維修類別",
          "整體滿意度", "保修處理", "結帳服務", "交修說明", "客休室", "均總分", "客戶聲音", "客戶聲音分類", "來源紀錄ID"]


def norm_plate(value):
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def staff_code(prefix, name):
    name = str(name or "").strip()
    return f"{prefix}-{hashlib.sha1(name.encode('utf-8')).hexdigest()[:8].upper()}" if name else ""


def mask_digits(text):
    # 客戶聲音可能夾帶電話或證號：連續 8 位以上數字一律遮罩。
    return re.sub(r"\d[\d\-\s]{6,}\d", "＊＊＊", text or "")


def load_records(path):
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".js":
        return json.loads(text[text.index("{"):text.rstrip().rstrip(";").rindex("}") + 1])["records"]
    with path.open(encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("records", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--onprem", type=Path, default=restore.DEFAULT_ONPREM)
    parser.add_argument("--cloud", type=Path, default=restore.DEFAULT_CLOUD)
    parser.add_argument("--units", type=Path, required=True, help="export_entities.py 產生的 units.csv（據點名稱→編碼）")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if "onedrive" in str(args.output.resolve()).lower():
        raise SystemExit("輸出位置在 OneDrive，請改存本機資料夾")

    onprem_rows = restore.load_uio_rows(args.onprem, "地端檔")
    lookup = restore.build_lookup(onprem_rows, args.cloud)          # 識別碼 → 地端列（含車牌）
    plate_to_code = {norm_plate(row[2]): code for code, row in lookup.items() if row[2]}
    with args.units.open(encoding="utf-8-sig") as handle:
        units = {row["單位名稱"]: row["單位編碼"] for row in csv.DictReader(handle)}

    records = load_records(args.records)
    seen, rows, unmatched = {}, [], 0
    for record in records:
        plate = norm_plate(record.get("p"))
        vehicle = plate_to_code.get(plate, "") if plate and plate != "NA" else ""
        if not vehicle:
            unmatched += 1
        branch = str(record.get("f") or "").strip()
        unit = units.get(branch) or units.get(branch + "廠") or ""
        identity = "|".join(str(record.get(key) or "") for key in ("y", "p", "e", "a", "t", "c", "o", "r", "k", "x", "l"))
        seen[identity] = seen.get(identity, 0) + 1
        code = "CSI-" + hashlib.sha1(f"{identity}#{seen[identity]}".encode("utf-8")).hexdigest()[:12].upper()
        rows.append([code, vehicle, vehicle, record.get("y") or "", record.get("e") or "", unit, staff_code("AD", record.get("a")), staff_code("TE", record.get("t")),
                     record.get("dl") or "", "是" if record.get("ft") == "Y" else "否" if record.get("ft") == "N" else "", record.get("c") or "",
                     record.get("o"), record.get("r"), record.get("k"), record.get("x"), record.get("l"), record.get("g"),
                     mask_digits(record.get("v")), record.get("vc") or "", code])
    with args.output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(HEADER)
        writer.writerows([["" if value is None else value for value in row] for row in rows])
    print(f"完成：{len(rows):,} 筆問卷，{len(rows) - unmatched:,} 筆對到車輛編碼，{unmatched:,} 筆無法對應（車輛編碼留空，仍計入據點／人員統計）")
    print(f"輸出：{args.output}（不含車牌，可上傳平台「資料匯入 → 滿意度問卷」）")


if __name__ == "__main__":
    main()

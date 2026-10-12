"""地端還原個資：把儀表板匯出的去識別化名單，依識別碼補回地端個資。

只在地端電腦執行。輸出的 Excel 含個資，請勿上傳雲端或 GitHub。
本程式只在畫面上顯示筆數統計，不會印出任何個資內容。

對應方式（自動判斷）：
  1. 地端檔 UIO 工作表若有一欄是 ES-xxxxx 識別碼，直接用該欄對應。
  2. 否則以列序對應（識別碼 ES-00001 = 第 2 列），但會先逐列比對雲端檔與地端檔的
     非個資欄位（車型代碼、領牌日期、保養廠別、工單日期），一致率不足就中止、不輸出。

用法：
  python restore_pii.py 匯出名單.xlsx [--onprem 地端檔.xlsx] [--cloud 雲端檔.xlsx]
"""
import argparse
import re
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.utils import get_column_letter

DATA_DIR = Path.home() / "OneDrive" / "桌面" / "AI參照" / "地端雲端資料"
DEFAULT_ONPREM = DATA_DIR / "UIO客戶數據平台(20261007)_地端_保留個資.xlsx"
DEFAULT_CLOUD = DATA_DIR / "UIO客戶數據平台(20261007)_雲端_去識別化.xlsx"
# 含個資的輸出固定放在不會被 OneDrive 同步的本機資料夾（桌面、文件在此電腦上會同步到雲端）。
DEFAULT_OUTPUT_DIR = Path.home() / "UIO含個資名單"

CODE_PATTERN = re.compile(r"^ES-(\d+)$")
# UIO 工作表欄位 → 輸出欄名（依原檔欄位順序）
PII_COLUMNS = [(2, "車牌"), (8, "VIN"), (24, "車主"), (30, "車主行動電話"), (28, "車主電話"), (31, "車主Email"), (32, "車主郵遞區號"), (33, "車主地址"), (34, "駕駛"), (40, "駕駛行動電話"), (41, "駕駛Email")]
# 列序對應時用來核對兩檔是否同一台車的非個資欄位：車型代碼、領牌日期、上次保養廠別、前一工單日期
ALIGNMENT_COLUMNS = [9, 11, 47, 48]
MIN_ALIGNMENT = 0.995


def text(value):
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M")
    return str(value).strip()


def readable_copy(path):
    """OneDrive 或 Excel 開啟中的檔案可能無法直接讀取，先複製到暫存區再讀。"""
    try:
        with open(path, "rb"):
            return path, None
    except PermissionError:
        tmp = Path(tempfile.mkdtemp()) / path.name
        shutil.copy2(path, tmp)
        return tmp, tmp.parent


def load_uio_rows(path, label):
    print(f"讀取{label}：{path.name}（檔案較大，約需 1–3 分鐘）…")
    source, cleanup = readable_copy(path)
    try:
        workbook = load_workbook(source, read_only=True, data_only=True)
        if "UIO" not in workbook.sheetnames:
            raise SystemExit(f"{label}找不到「UIO」工作表，已中止。")
        rows = [tuple(row) for row in workbook["UIO"].iter_rows(min_row=2, values_only=True)]
        workbook.close()
        return rows
    finally:
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)


def find_code_column(rows):
    sample = rows[:500]
    best, best_ratio = None, 0.0
    for index in range(max((len(r) for r in sample), default=0)):
        values = [text(r[index]) for r in sample if index < len(r) and r[index] not in (None, "")]
        if not values:
            continue
        ratio = sum(bool(CODE_PATTERN.match(v)) for v in values) / len(sample)
        if ratio > best_ratio:
            best, best_ratio = index, ratio
    return best if best_ratio >= 0.9 else None


def build_lookup(onprem_rows, cloud_path):
    code_column = find_code_column(onprem_rows)
    if code_column is not None:
        print(f"對應方式：地端檔第 {get_column_letter(code_column + 1)} 欄為識別碼，直接對應。")
        return {text(row[code_column]): row for row in onprem_rows if CODE_PATTERN.match(text(row[code_column]))}

    print("對應方式：地端檔沒有識別碼欄，改用列序對應，先核對兩檔是否同一順序…")
    if not cloud_path.exists():
        raise SystemExit(f"找不到雲端去識別化檔，無法核對列序：{cloud_path}\n請用 --cloud 指定檔案位置。")
    cloud_rows = load_uio_rows(cloud_path, "雲端檔")
    if len(cloud_rows) != len(onprem_rows):
        raise SystemExit(f"兩檔筆數不同（雲端 {len(cloud_rows):,}／地端 {len(onprem_rows):,}），無法用列序對應，已中止。")
    lookup, compared, agreed = {}, 0, 0
    for cloud_row, onprem_row in zip(cloud_rows, onprem_rows):
        code = text(cloud_row[2])
        if not CODE_PATTERN.match(code):
            continue
        for index in ALIGNMENT_COLUMNS:
            left, right = text(cloud_row[index]), text(onprem_row[index])
            if left or right:
                compared += 1
                agreed += left == right
        lookup[code] = onprem_row
    rate = agreed / compared if compared else 0
    print(f"列序核對：{agreed:,}／{compared:,} 個欄位一致（{rate:.2%}）。")
    if rate < MIN_ALIGNMENT:
        raise SystemExit(f"一致率低於 {MIN_ALIGNMENT:.1%}，兩檔順序可能不同，為避免對錯人已中止，未輸出任何檔案。")
    return lookup


def main():
    parser = argparse.ArgumentParser(description="依識別碼把地端個資補回儀表板匯出名單")
    parser.add_argument("export", type=Path, help="儀表板匯出的去識別化 Excel")
    parser.add_argument("--onprem", type=Path, default=DEFAULT_ONPREM, help="地端保留個資 Excel")
    parser.add_argument("--cloud", type=Path, default=DEFAULT_CLOUD, help="雲端去識別化 Excel（列序核對用）")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="含個資名單輸出資料夾")
    args = parser.parse_args()

    for path, label in ((args.export, "匯出名單"), (args.onprem, "地端個資檔")):
        if not path.exists():
            raise SystemExit(f"找不到{label}：{path}")

    export_book = load_workbook(args.export, read_only=True, data_only=True)
    export_rows = list(export_book.active.iter_rows(values_only=True))
    export_book.close()
    if not export_rows or "識別碼" not in export_rows[0]:
        raise SystemExit("匯出名單第一列找不到「識別碼」欄，請使用儀表板「匯出目前結果 Excel」產生的檔案。")
    header = list(export_rows[0])
    code_index = header.index("識別碼")
    print(f"匯出名單：{len(export_rows) - 1:,} 筆")

    lookup = build_lookup(load_uio_rows(args.onprem, "地端檔"), args.cloud)

    output = Workbook()
    sheet = output.active
    sheet.title = "含個資名單"
    pii_headers = [name for _, name in PII_COLUMNS]
    sheet.append(header[:code_index + 1] + pii_headers + header[code_index + 1:])
    matched = 0
    for row in export_rows[1:]:
        row = list(row)
        source = lookup.get(text(row[code_index]))
        pii = [text(source[index]) if source is not None and index < len(source) else "" for index, _ in PII_COLUMNS]
        matched += source is not None
        sheet.append(row[:code_index + 1] + pii + row[code_index + 1:])
    sheet.freeze_panes = "B2"
    sheet.auto_filter.ref = sheet.dimensions
    for index, name in enumerate(sheet[1], 1):
        sheet.column_dimensions[get_column_letter(index)].width = min(32, max(11, len(str(name.value or "")) * 2 + 2))

    if "onedrive" in str(args.output_dir.resolve()).lower():
        raise SystemExit(f"輸出資料夾位於 OneDrive（會同步到雲端），已中止：{args.output_dir}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    target = args.output_dir / f"{args.export.stem}_含個資.xlsx"
    output.save(target)
    missing = len(export_rows) - 1 - matched
    print(f"\n完成：{matched:,} 筆已補回個資" + (f"，{missing:,} 筆在地端檔找不到（個資欄留空）" if missing else "") + "。")
    print(f"輸出檔：{target}")
    print("※ 此檔含個資，請只存放在地端，勿上傳雲端、GitHub 或以通訊軟體傳送。")


def run_from_shortcut():
    """桌面捷徑直接呼叫 python：結束前一律暫停，錯誤寫入記錄檔，視窗不會一閃而過。"""
    import os
    import traceback
    sys.argv.remove("--pause")
    status = 0
    try:
        if len(sys.argv) < 2:
            # 雙擊開啟時：讓使用者把檔案拖進這個視窗（會貼上路徑），再按 Enter。
            dropped = input("請把儀表板匯出的 Excel 拖進這個視窗，然後按 Enter：\n> ").strip("﻿ \t\"'")
            if not dropped:
                raise SystemExit("沒有收到檔案，已結束。")
            sys.argv.append(dropped)
        main()
        os.startfile(DEFAULT_OUTPUT_DIR)
    except SystemExit as error:
        status = error.code if isinstance(error.code, int) else 1
        if isinstance(error.code, str):
            print(f"\n{error.code}")
    except BaseException:
        status = 1
        print("\n發生錯誤：")
        traceback.print_exc()
        DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        with (DEFAULT_OUTPUT_DIR / "還原個資_錯誤記錄.txt").open("a", encoding="utf-8") as log:
            log.write(f"\n==== {datetime.now():%Y-%m-%d %H:%M:%S} {sys.argv[1:]}\n{traceback.format_exc()}")
        print(f"\n錯誤已記錄到：{DEFAULT_OUTPUT_DIR / '還原個資_錯誤記錄.txt'}")
    input("\n按 Enter 關閉視窗…")
    sys.exit(status)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if "--pause" in sys.argv:
        run_from_shortcut()
    else:
        main()

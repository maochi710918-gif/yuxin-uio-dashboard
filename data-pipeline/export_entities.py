"""地端轉檔：把去識別化 UIO 活頁簿拆成平台的標準匯入檔（每個實體一個 CSV）。

輸出的欄位名稱與平台「資料匯入」範本一致，可直接上傳或用 scripts/import-entities.mjs 批次匯入。
只處理已編碼／遮罩的資料；任何非編碼格式的個資欄位會讓轉檔中止。

用法：
  python export_entities.py 去識別化.xlsx 輸出資料夾 --data-date 2026-10-07
"""
import argparse
import csv
import hashlib
import re
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from openpyxl import load_workbook

CODE = re.compile(r"^ES-\d+$")
PII_COLUMNS = {2: "牌照號碼", 6: "車身#", 7: "引擎#", 8: "VIN#", 24: "車主", 28: "車主電話", 29: "車主電話2", 30: "車主行動電話", 31: "車主Email", 33: "車主地址", 34: "駕駛", 38: "駕駛電話", 39: "駕駛電話2", 40: "駕駛行動電話", 41: "駕駛Email", 43: "駕駛地址"}


def text(value):
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def iso(value):
    value = text(value).replace("/", "-")
    match = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", value)
    return f"{match.group(1)}-{int(match.group(2)):02d}-{int(match.group(3)):02d}" if match else ""


def number(value):
    value = text(value).replace(",", "")
    try:
        return float(value) if value else None
    except ValueError:
        return None


def integer(value):
    parsed = number(value)
    return int(round(parsed)) if parsed is not None else None


def fmt(value):
    if value is None:
        return ""
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else f"{value:.2f}"
    return str(value)


def provisional_code(prefix, name):
    """Stable placeholder code for people/units that the source only identifies by name (code_status = 暫用)."""
    return f"{prefix}-{hashlib.sha1(name.encode('utf-8')).hexdigest()[:8].upper()}"


class Writer:
    def __init__(self, folder):
        self.folder = folder
        self.counts = {}

    def write(self, name, header, rows):
        path = self.folder / f"{name}.csv"
        with path.open("w", encoding="utf-8-sig", newline="") as handle:
            out = csv.writer(handle)
            out.writerow(header)
            for row in rows:
                out.writerow([fmt(value) for value in row])
        self.counts[name] = len(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--data-date", required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sys.stdout.reconfigure(encoding="utf-8")

    workbook = load_workbook(args.workbook, read_only=True, data_only=True)
    out = Writer(args.output)

    # --- units: codes come from the spend / beauty sheets (代碼 + 名稱); names without a code get a provisional code.
    unit_by_name, unit_status = {}, {}
    for sheet, code_col, name_col in (("美容", 0, 1), ("3個月消費總金額-205", 1, 2)):
        for row in workbook[sheet].iter_rows(min_row=2, values_only=True):
            code, name = text(row[code_col]), text(row[name_col])
            if code and name and name not in unit_by_name:
                unit_by_name[name], unit_status[name] = code, "正式"

    def unit_code(name):
        name = text(name)
        if not name:
            return ""
        if name not in unit_by_name:
            unit_by_name[name], unit_status[name] = provisional_code("U", name), "暫用（依名稱）"
        return unit_by_name[name]

    summary = {}
    for row in workbook["總表"].iter_rows(min_row=2, values_only=True):
        if text(row[0]):
            summary[text(row[0])] = row

    customers, vehicles, relations, vehicle_staff, staff = {}, [], [], [], {}
    summary_rows = []

    def staff_code(role, name):
        name = text(name)
        if not name:
            return ""
        prefix = {"sales": "SA", "advisor": "AD", "technician": "TE"}[role]
        code = provisional_code(prefix, name)
        staff.setdefault(code, (code, name, role, "", "暫用（依名稱）"))
        return code

    for row in workbook["UIO"].iter_rows(min_row=2, values_only=True):
        vehicle = text(row[2])
        if not vehicle:
            continue
        for index, label in PII_COLUMNS.items():
            value = text(row[index])
            if value and not CODE.match(value):
                raise SystemExit(f"中止：{label} 欄出現非編碼值，請確認來源已去識別化")
        total = summary.get(vehicle)
        t = (lambda i: total[i]) if total else (lambda i: None)

        visits = [(iso(row[44]), integer(row[45])), (iso(row[48]), integer(row[49])), (iso(row[53]), integer(row[54])), (iso(row[58]), integer(row[59]))]
        visits = [(day, km) for day, km in visits if day]
        last_visit = max((day for day, _ in visits), default="")
        with_km = [(day, km) for day, km in visits if km is not None and 0 <= km <= 2_000_000]
        mileage_day, mileage = max(with_km, key=lambda item: (item[1], item[0])) if with_km else ("", None)
        consent = text(row[26])
        opt_out = bool(text(row[0]))
        owner = text(row[24])
        if owner:
            customer_type = "法人" if text(row[25]) == "公司法人" else "個人"
            birth = text(row[27])
            customers.setdefault(owner, [
                owner, customer_type, "" if customer_type == "法人" else text(row[25]),
                int(birth) if re.fullmatch(r"\d{4}", birth) else None, integer(t(6)), "",
                text(t(10)) or text(row[17]), text(t(11)), text(t(14)), consent,
                1 if ("同意" in consent and not opt_out) else 0,
                1 if (text(row[30]) or text(row[28]) or text(row[29])) else 0, 1 if text(row[30]) else 0, 1 if text(row[31]) else 0, None,
                1 if opt_out else 0, text(row[1]), None, None, owner,
            ])
            relations.append((vehicle, owner, "持有人", "", "", vehicle))
        driver = text(row[34])
        if driver:
            if driver not in customers:
                d_consent = text(row[36])
                customers[driver] = [driver, "法人" if text(row[35]) == "公司法人" else "個人", "" if text(row[35]) == "公司法人" else text(row[35]), None, None, "", text(row[17]), "", "", d_consent, 1 if "同意" in d_consent else 0, 1 if (text(row[40]) or text(row[38])) else 0, 1 if text(row[40]) else 0, 1 if text(row[41]) else 0, None, 0, "", None, None, driver]
            relations.append((vehicle, driver, "使用人", "", "", vehicle))
        branch = text(row[47]) or text(row[52]) or text(row[57])
        vehicles.append([
            vehicle, text(t(8)) or text(row[9])[:3], text(row[9]) or text(row[10]), iso(row[11]), "",
            mileage, mileage_day, "實際" if mileage is not None else "", iso(row[12]), 100000, iso(row[62]), iso(row[14]),
            unit_code(branch), last_visit, iso(row[44]), integer(row[45]), integer(row[16]), integer(row[15]), vehicle,
        ])
        for role, name in (("sales", row[21]), ("advisor", text(t(15)) or text(row[50])), ("technician", t(16))):
            code = staff_code(role, name)
            if code:
                vehicle_staff.append((vehicle, role, code, "", ""))
        if total:
            keys = ["vehicleAgeText", "maintenanceCount1y", "returnCategory", "maintenanceFrequency", "spend3m", "beautySpend1y", "beautyHighSpend", "fakeBeautySpend1y",
                    "windshieldCoatingCount1y", "windshieldCoatingSpend1y", "waxCount1y", "waxSpend1y", "bodyBeautyCount1y", "bodyBeautySpend1y", "interiorCleaningCount1y", "interiorCleaningSpend1y", "bodyCoatingCount1y", "bodyCoatingSpend1y",
                    "tireChanges1y", "batteryChanges1y", "airFilterChanges1y", "cabinFilterChanges1y", "wiperChanges1y", "brakePadChanges1y", "beltChanges1y", "sparkPlugChanges1y",
                    "tireLastChanged", "batteryLastChanged", "airFilterLastChanged", "cabinFilterLastChanged", "wiperLastChanged", "brakePadLastChanged", "beltLastChanged", "sparkPlugLastChanged"]
            cols = [7, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]
            summary_rows.append([vehicle] + [iso(total[c]) if k.endswith("LastChanged") else text(total[c]) for k, c in zip(keys, cols)])

    # --- transactions, one file per source; amounts are summed per work order so each source contributes one record per transaction.
    repair = []
    for row in workbook["一年內維修次數-4W0"].iter_rows(min_row=2, values_only=True):
        wo, vehicle = text(row[4]), text(row[11])
        if not wo or not vehicle:
            continue
        code = f"{unit_code(row[1])}-{wo}"
        kind = text(row[7])
        txn_type = ("保養" if (number(row[22]) or 0) > 0 else "維修") if kind == "自費" else ("理賠" if kind == "理賠" else "其他")
        repair.append((code, code, txn_type, vehicle, "", iso(row[6]) or iso(row[5]), unit_code(row[1]), text(row[51]), text(row[53]), integer(row[19]), number(row[47]), None, None))

    spend = defaultdict(lambda: {"amount": 0.0, "net": 0.0, "cost": 0.0, "has_cost": False})
    spend_meta = {}
    for row in workbook["3個月消費總金額-205"].iter_rows(min_row=2, values_only=True):
        wo, vehicle, unit = text(row[5]), text(row[7]), text(row[1])
        if not wo or not vehicle or not unit:
            continue
        code = f"{unit}-{wo}"
        bucket = spend[code]
        bucket["amount"] += number(row[16]) or 0
        bucket["net"] += number(row[14]) or 0
        labour_cost, parts_cost = number(row[20]), number(row[22])
        if labour_cost is not None or parts_cost is not None:
            bucket["has_cost"] = True
            bucket["cost"] += (labour_cost or 0) + (parts_cost or 0)
        spend_meta.setdefault(code, (vehicle, iso(row[4]), unit, "理賠" if text(row[6]) == "理賠" else "維修", text(row[26]), text(row[28])))
    spend_rows = []
    for code, bucket in spend.items():
        vehicle, day, unit, txn_type, advisor, technician = spend_meta[code]
        cost = bucket["cost"] if bucket["has_cost"] else None
        spend_rows.append((code, code, txn_type, vehicle, "", day, unit, advisor, technician, None, bucket["amount"], cost, (bucket["net"] - cost) if cost is not None else None))

    beauty = defaultdict(float)
    beauty_meta = {}
    for row in workbook["美容"].iter_rows(min_row=2, values_only=True):
        wo, vehicle, unit = text(row[5]), text(row[7]), text(row[0])
        if not wo or not vehicle or not unit:
            continue
        code = f"{unit}-{wo}"
        beauty[code] += number(row[15]) or 0
        beauty_meta.setdefault(code, (vehicle, iso(row[2]) or iso(row[4]), unit))
    beauty_rows = [(code, code, "美容", beauty_meta[code][0], "", beauty_meta[code][1], beauty_meta[code][2], "", "", None, amount, None, None) for code, amount in beauty.items()]
    workbook.close()

    txn_header = ["交易編碼", "來源紀錄ID", "交易類型", "車輛編碼", "客戶編碼", "交易日", "單位編碼", "服專編碼", "技師編碼", "進廠里程", "金額", "成本", "毛利"]
    vehicle_codes = {row[0] for row in vehicles}
    for name, rows in (("transactions_repair", repair), ("transactions_spend", spend_rows), ("transactions_beauty", beauty_rows)):
        out.write(name, txn_header, [row for row in rows if row[3] in vehicle_codes])
        out.counts[name + "_skipped_unknown_vehicle"] = sum(1 for row in rows if row[3] not in vehicle_codes)

    out.write("units", ["單位編碼", "單位名稱", "單位類型", "上層單位編碼", "編碼狀態"], [(code, name, "據點", "", unit_status[name]) for name, code in unit_by_name.items()])
    out.write("staff", ["人員編碼", "顯示名稱", "人員角色", "所屬單位編碼", "編碼狀態"], list(staff.values()))
    out.write("customers", ["客戶編碼", "客戶類型", "性別", "出生年", "年齡", "歸屬單位編碼", "縣市", "行政區", "會員護照", "個資授權狀態", "可聯絡", "可電話", "可簡訊", "可Email", "可LINE", "拒收", "拒收原因", "客訴處理中", "滿意度", "來源紀錄ID"], list(customers.values()))
    out.write("vehicles", ["車輛編碼", "車型", "車型代碼", "領牌日", "交車日", "最新里程", "里程紀錄日", "里程依據", "保固到期日", "保固里程上限", "延長保固到期日", "保險到期日", "服務單位編碼", "最後進廠日", "最後定保日", "最後定保里程", "保養週期月", "保養週期里程", "來源紀錄ID"], vehicles)
    out.write("vehicle_relations", ["車輛編碼", "客戶編碼", "關係", "起日", "迄日", "來源紀錄ID"], relations)
    out.write("vehicle_staff", ["車輛編碼", "人員角色", "人員編碼", "起日", "迄日"], vehicle_staff)
    out.write("vehicle_service_summary", ["車輛編碼", "vehicleAgeText", "maintenanceCount1y", "returnCategory", "maintenanceFrequency", "spend3m", "beautySpend1y", "beautyHighSpend", "fakeBeautySpend1y", "windshieldCoatingCount1y", "windshieldCoatingSpend1y", "waxCount1y", "waxSpend1y", "bodyBeautyCount1y", "bodyBeautySpend1y", "interiorCleaningCount1y", "interiorCleaningSpend1y", "bodyCoatingCount1y", "bodyCoatingSpend1y", "tireChanges1y", "batteryChanges1y", "airFilterChanges1y", "cabinFilterChanges1y", "wiperChanges1y", "brakePadChanges1y", "beltChanges1y", "sparkPlugChanges1y", "tireLastChanged", "batteryLastChanged", "airFilterLastChanged", "cabinFilterLastChanged", "wiperLastChanged", "brakePadLastChanged", "beltLastChanged", "sparkPlugLastChanged"], summary_rows)
    (args.output / "data_date.txt").write_text(args.data_date, encoding="utf-8")
    for name, count in out.counts.items():
        print(f"{name}: {count:,}")


if __name__ == "__main__":
    main()

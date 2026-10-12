-- 0002_seed_rules: data sources, preset segments and automation rules (all automation rules start disabled).
-- Source priority: lower number wins when two sources disagree on the same field.

INSERT OR IGNORE INTO sources (source_code, name, entity, priority, description) VALUES
 ('UIO-UNIT', 'UIO 據點代碼（美容／消費明細）', 'units', 10, '據點代碼與名稱'),
 ('UIO-STAFF', 'UIO 人員（依姓名暫編）', 'staff', 50, '來源僅提供姓名，平台依姓名產生暫用人員編碼'),
 ('UIO-CUST', 'UIO 車主／駕駛', 'customers', 20, 'UIO 工作表車主與駕駛欄（已編碼）'),
 ('UIO-VEH', 'UIO 車籍', 'vehicles', 20, 'UIO 工作表車籍、保固、保養週期'),
 ('UIO-REL', 'UIO 人車關係', 'vehicle_relations', 20, '車主＝持有人、駕駛＝使用人'),
 ('UIO-VSTAFF', 'UIO 負責人員', 'vehicle_staff', 20, '銷售人員、指定服專、指定技師'),
 ('UIO-SUMMARY', 'UIO 總表彙總', 'vehicle_service_summary', 20, '一年服務次數與金額彙總'),
 ('DMS-REPAIR', '一年內維修工單', 'transactions', 10, '工單抬頭與金額（最高優先）'),
 ('DMS-SPEND', '近三月消費（含成本）', 'transactions', 20, '提供成本以計算毛利'),
 ('DMS-BEAUTY', '美容明細', 'transactions', 30, '依工單加總之美容金額'),
 ('CRM-INTERACTION', '互動紀錄（聯絡／試乘／報價／客訴）', 'interactions', 20, '尚待地端提供'),
 ('CRM-GROUP', '家庭／企業關係', 'relation_groups', 20, '尚待地端提供');

INSERT OR IGNORE INTO segments (segment_code, name, description, definition, is_preset, version, created_by, created_at, updated_at) VALUES
 ('SEG-P01', '保養即將到期', '依最後定保日＋保養週期（月）推算；逾期 60 天內或 30 天內到期。', '{"op":"AND","items":[{"field":"maintenance_due_days","op":"between","value":-60,"value2":30}]}', 1, 1, 'system', '2026-10-07', '2026-10-07'),
 ('SEG-P02', '超過設定期間未回廠', '未回廠天數 ≥ 365（可調整）。', '{"op":"AND","items":[{"field":"last_visit_days","op":"gte","value":365}]}', 1, 1, 'system', '2026-10-07', '2026-10-07'),
 ('SEG-P03', '保固／保險即將到期', '保固剩餘 0–180 天、或實際里程剩餘 0–20,000 km、或保險 60 天內到期。', '{"op":"OR","items":[{"field":"warranty_days_left","op":"between","value":0,"value2":180},{"field":"warranty_km_left","op":"between","value":0,"value2":20000},{"field":"insurance_days_left","op":"between","value":0,"value2":60}]}', 1, 1, 'system', '2026-10-07', '2026-10-07'),
 ('SEG-P04', '試乘或報價後尚未成交', '90 天內有試乘或報價，且無成交商機。需互動來源。', '{"op":"AND","items":[{"field":"last_test_drive_or_quote_days","op":"lte","value":90},{"field":"won_opps","op":"eq","value":0}]}', 1, 1, 'system', '2026-10-07', '2026-10-07'),
 ('SEG-P05', '換購／增購／轉介線索', '換購線索分數 ≥ 50、持有 ≥ 2 台或有進行中售後轉介。為線索，需業代確認。', '{"op":"OR","items":[{"field":"replacement_score","op":"gte","value":50},{"field":"owned_vehicles","op":"gte","value":2},{"field":"open_referrals","op":"gte","value":1}]}', 1, 1, 'system', '2026-10-07', '2026-10-07'),
 ('SEG-P06', '高價值客戶', '客戶價值分數 ≥ 60。', '{"op":"AND","items":[{"field":"value_score","op":"gte","value":60}]}', 1, 1, 'system', '2026-10-07', '2026-10-07'),
 ('SEG-P07', '需要優先服務或關懷', '客訴處理中、流失風險 ≥ 50，或保固即將到期且保養已逾期。', '{"op":"OR","items":[{"field":"complaint_open","op":"eq","value":1},{"field":"churn_score","op":"gte","value":50},{"op":"AND","items":[{"field":"warranty_days_left","op":"between","value":0,"value2":180},{"field":"maintenance_due_days","op":"lte","value":0}]}]}', 1, 1, 'system', '2026-10-07', '2026-10-07');

INSERT OR IGNORE INTO automation_rules (rule_code, version, name, definition, enabled, is_current, updated_by, updated_at) VALUES
 ('AR-MAINT', 1, '保養提醒', '{"trigger":{"kind":"segment","segment_code":"SEG-P01"},"task":{"task_type":"保養提醒","action":"邀約回廠定期保養","owner_role":"advisor","due_days":7,"priority":2,"promotional":false},"stop":["已預約","已成交","拒收","需求取消"]}', 0, 1, 'system', '2026-10-07'),
 ('AR-WARRANTY', 1, '保固到期健檢', '{"trigger":{"kind":"definition","definition":{"op":"OR","items":[{"field":"warranty_days_left","op":"between","value":0,"value2":180},{"field":"warranty_km_left","op":"between","value":0,"value2":20000}]}},"task":{"task_type":"保固到期","action":"3 日內聯絡並安排保固到期前健檢","owner_role":"advisor","due_days":3,"priority":1,"promotional":false},"stop":["已預約","已成交","拒收","需求取消"]}', 0, 1, 'system', '2026-10-07'),
 ('AR-INSURANCE', 1, '續保提醒', '{"trigger":{"kind":"definition","definition":{"op":"AND","items":[{"field":"insurance_days_left","op":"between","value":0,"value2":60}]}},"task":{"task_type":"續保","action":"提醒保險到期並提供續保報價","owner_role":"sales","due_days":7,"priority":2,"promotional":true,"opp_type":"保險"},"stop":["已成交","拒收","需求取消"]}', 0, 1, 'system', '2026-10-07'),
 ('AR-DORMANT', 1, '未回廠邀約', '{"trigger":{"kind":"definition","definition":{"op":"AND","items":[{"field":"last_visit_days","op":"gte","value":270}]}},"task":{"task_type":"未回廠邀約","action":"由原服專邀約回廠與車況健檢","owner_role":"advisor","due_days":7,"priority":2,"promotional":true},"stop":["已預約","已成交","拒收","需求取消"]}', 0, 1, 'system', '2026-10-07'),
 ('AR-TESTDRIVE', 1, '試乘後追蹤', '{"trigger":{"kind":"definition","definition":{"op":"AND","items":[{"field":"last_test_drive_or_quote_days","op":"lte","value":3},{"field":"won_opps","op":"eq","value":0}]}},"task":{"task_type":"試乘後追蹤","action":"試乘後 3 日內回訪並確認需求","owner_role":"sales","due_days":2,"priority":1,"promotional":false,"opp_type":"新車"},"stop":["已成交","拒收","需求取消"]}', 0, 1, 'system', '2026-10-07'),
 ('AR-QUOTE', 1, '報價追蹤', '{"trigger":{"kind":"definition","definition":{"op":"AND","items":[{"field":"last_test_drive_or_quote_days","op":"between","value":4,"value2":30},{"field":"won_opps","op":"eq","value":0},{"field":"open_opps","op":"gte","value":1}]}},"task":{"task_type":"報價追蹤","action":"追蹤報價並確認決策時程","owner_role":"sales","due_days":3,"priority":1,"promotional":false},"stop":["已成交","拒收","需求取消"]}', 0, 1, 'system', '2026-10-07'),
 ('AR-REFERRAL', 1, '轉介逾期提醒', '{"trigger":{"kind":"referral_overdue","hours":48},"task":{"task_type":"轉介逾期","action":"售後轉介超過 48 小時未接手，請據點主管確認指派","owner_role":"unit","due_days":1,"priority":1,"promotional":false},"stop":[]}', 0, 1, 'system', '2026-10-07');

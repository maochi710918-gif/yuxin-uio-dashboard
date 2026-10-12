-- 0001_crm_core: CDP + CRM core model. All business codes are TEXT (leading zeros preserved).
-- Every imported row keeps source_code / source_record_id / batch_code / data_date for lineage.
-- NULL means 資料不足; a source that has never been imported is reported as 尚未串接 (see sources.status).

CREATE TABLE IF NOT EXISTS sources (
  source_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,           -- lower number wins on field conflicts
  status TEXT NOT NULL DEFAULT '尚未串接',          -- 尚未串接 / 已串接
  description TEXT NOT NULL DEFAULT '',
  last_batch_code TEXT,
  last_imported_at TEXT
);

CREATE TABLE IF NOT EXISTS units (
  unit_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit_type TEXT NOT NULL DEFAULT '據點',           -- 公司 / 據點 / 部門
  parent_code TEXT,
  code_status TEXT NOT NULL DEFAULT '正式',         -- 正式 / 暫用（依名稱）
  source_code TEXT, batch_code TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  staff_code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  staff_role TEXT NOT NULL,                        -- sales / advisor / technician
  unit_code TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  code_status TEXT NOT NULL DEFAULT '正式',
  source_code TEXT, batch_code TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS staff_role_idx ON staff (staff_role, display_name);

CREATE TABLE IF NOT EXISTS customers (
  customer_code TEXT PRIMARY KEY,
  customer_type TEXT,                              -- 個人 / 法人
  gender TEXT,
  birth_year INTEGER,
  age INTEGER,
  home_unit_code TEXT,
  county TEXT, district TEXT,
  member_passport TEXT,
  consent_status TEXT,                             -- 地端提供之授權狀態
  contact_eligible INTEGER,                        -- 1 可聯絡 / 0 不可 / NULL 資料不足
  channel_phone INTEGER, channel_sms INTEGER, channel_email INTEGER, channel_line INTEGER,
  opt_out INTEGER,                                 -- 拒收（暫停聯絡）
  opt_out_reason TEXT,
  complaint_open INTEGER,                          -- 客訴處理中（NULL = 尚未串接）
  satisfaction_score REAL,
  source_code TEXT, source_record_id TEXT, batch_code TEXT, data_date TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS customers_unit_idx ON customers (home_unit_code);

CREATE TABLE IF NOT EXISTS relation_groups (
  group_code TEXT PRIMARY KEY,
  group_type TEXT NOT NULL,                        -- 家庭 / 企業
  source_code TEXT, batch_code TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relation_group_members (
  group_code TEXT NOT NULL,
  customer_code TEXT NOT NULL,
  member_role TEXT,
  valid_from TEXT NOT NULL DEFAULT '',
  valid_to TEXT,
  source_code TEXT, batch_code TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (group_code, customer_code, valid_from)
);
CREATE INDEX IF NOT EXISTS group_members_customer_idx ON relation_group_members (customer_code);

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_code TEXT PRIMARY KEY,
  model_series TEXT, model_code TEXT,
  registration_date TEXT, delivery_date TEXT,
  latest_mileage INTEGER, mileage_date TEXT, mileage_basis TEXT,   -- 實際 / 推估
  warranty_expiry TEXT, warranty_km_limit INTEGER NOT NULL DEFAULT 100000,
  extended_warranty_expiry TEXT, insurance_expiry TEXT,
  service_unit_code TEXT,
  last_visit_date TEXT,
  last_maintenance_date TEXT, last_maintenance_mileage INTEGER,
  maintenance_interval_months INTEGER, maintenance_interval_km INTEGER,
  source_code TEXT, source_record_id TEXT, batch_code TEXT, data_date TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vehicles_unit_idx ON vehicles (service_unit_code);
CREATE INDEX IF NOT EXISTS vehicles_model_idx ON vehicles (model_series);

-- 人車關係：持有人 / 使用人 / 付款人 / 決策者，以有效期間保留歷史（轉手時舊關係補上 valid_to）。
CREATE TABLE IF NOT EXISTS vehicle_relations (
  vehicle_code TEXT NOT NULL,
  customer_code TEXT NOT NULL,
  relation TEXT NOT NULL,
  valid_from TEXT NOT NULL DEFAULT '',
  valid_to TEXT,
  source_code TEXT, source_record_id TEXT, batch_code TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (vehicle_code, customer_code, relation, valid_from)
);
CREATE INDEX IF NOT EXISTS vehicle_relations_customer_idx ON vehicle_relations (customer_code, valid_to);

-- 責任人員（業代 / 服專 / 技師）對車輛的指派，同樣保留期間。
CREATE TABLE IF NOT EXISTS vehicle_staff (
  vehicle_code TEXT NOT NULL,
  staff_role TEXT NOT NULL,
  staff_code TEXT NOT NULL,
  valid_from TEXT NOT NULL DEFAULT '',
  valid_to TEXT,
  source_code TEXT, batch_code TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (vehicle_code, staff_role, staff_code, valid_from)
);
CREATE INDEX IF NOT EXISTS vehicle_staff_staff_idx ON vehicle_staff (staff_code, valid_to);

-- 來源提供的彙總指標（例如 UIO 總表一年服務次數），保留以支援既有分析；明細以 transactions 為準。
CREATE TABLE IF NOT EXISTS vehicle_service_summary (
  vehicle_code TEXT PRIMARY KEY,
  payload TEXT NOT NULL,                           -- JSON
  source_code TEXT, batch_code TEXT, data_date TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  txn_code TEXT PRIMARY KEY,
  txn_type TEXT,                                   -- 購車 / 保養 / 維修 / 保險 / 美容 / 理賠 / 其他
  vehicle_code TEXT, customer_code TEXT,
  txn_date TEXT,
  unit_code TEXT, advisor_code TEXT, technician_code TEXT,
  mileage INTEGER,
  amount REAL, cost REAL, margin REAL,
  source_code TEXT, batch_code TEXT, data_date TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_vehicle_idx ON transactions (vehicle_code, txn_date);
CREATE INDEX IF NOT EXISTS transactions_customer_idx ON transactions (customer_code, txn_date);
-- 每個來源各自的原始紀錄，用於重複匯入判斷與欄位衝突追溯。
CREATE TABLE IF NOT EXISTS transaction_source_records (
  txn_code TEXT NOT NULL,
  source_code TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  batch_code TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_code, source_record_id)
);
CREATE INDEX IF NOT EXISTS txn_source_txn_idx ON transaction_source_records (txn_code);

CREATE TABLE IF NOT EXISTS interactions (
  interaction_code TEXT PRIMARY KEY,
  interaction_type TEXT NOT NULL,                  -- 聯絡 / 詢問 / 試乘 / 報價 / 活動 / 到店 / 客訴 / 滿意度
  customer_code TEXT, vehicle_code TEXT,
  channel TEXT, occurred_at TEXT,
  staff_code TEXT, unit_code TEXT,
  outcome TEXT, detail TEXT,
  task_code TEXT, opp_code TEXT, campaign_code TEXT,
  source_code TEXT, source_record_id TEXT, batch_code TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interactions_customer_idx ON interactions (customer_code, occurred_at);

CREATE TABLE IF NOT EXISTS opportunities (
  opp_code TEXT PRIMARY KEY,
  opp_type TEXT NOT NULL,                          -- 新車 / 換購 / 增購 / 保險 / 售後服務
  customer_code TEXT NOT NULL,
  vehicle_code TEXT,
  origin TEXT NOT NULL,                            -- 手動 / 自動化規則 / 售後轉介 / 匯入
  need TEXT, product TEXT, budget_band TEXT,
  expected_decision_date TEXT,
  stage TEXT NOT NULL,                             -- 分派 / 已聯絡 / 有效回覆 / 預約 / 到店試乘 / 報價 / 成交 / 未成交
  max_stage_rank INTEGER NOT NULL DEFAULT 0,       -- 曾到達的最遠階段（漏斗以此計算，未成交不會抹除歷程）
  owner_staff_code TEXT, owner_unit_code TEXT,
  handover_status TEXT NOT NULL DEFAULT '已接手',   -- 待接手 / 已接手 / 已退回
  referral_from_unit TEXT, referral_by_staff TEXT, referral_need TEXT,
  next_step TEXT, next_due_date TEXT,
  close_result TEXT, lost_reason TEXT, won_txn_code TEXT,
  rule_code TEXT, rule_version INTEGER,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS opportunities_customer_idx ON opportunities (customer_code);
CREATE INDEX IF NOT EXISTS opportunities_owner_idx ON opportunities (owner_staff_code, stage);
CREATE TABLE IF NOT EXISTS opportunity_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  opp_code TEXT NOT NULL,
  event_type TEXT NOT NULL,                        -- 建立 / 接手 / 退回 / 轉派 / 階段變更 / 結案 / 回傳
  from_value TEXT, to_value TEXT, note TEXT,
  actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS opportunity_events_opp_idx ON opportunity_events (opp_code, event_id);

CREATE TABLE IF NOT EXISTS segments (
  segment_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL,                        -- JSON 條件樹（AND / OR / NOT 群組）
  is_preset INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  campaign_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  segment_code TEXT, segment_version INTEGER,
  cost REAL,
  start_date TEXT, end_date TEXT,
  status TEXT NOT NULL DEFAULT '進行中',
  snapshot_at TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
-- 活動名單快照：產生當下的成員與入選／排除原因，不隨客群更新而改變。
CREATE TABLE IF NOT EXISTS campaign_members (
  campaign_code TEXT NOT NULL,
  customer_code TEXT NOT NULL,
  vehicle_code TEXT NOT NULL DEFAULT '',
  included INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (campaign_code, customer_code, vehicle_code)
);

CREATE TABLE IF NOT EXISTS tasks (
  task_code TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  customer_code TEXT NOT NULL,
  vehicle_code TEXT,
  opp_code TEXT, campaign_code TEXT, segment_code TEXT,
  rule_code TEXT, rule_version INTEGER,
  reason TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,             -- 1 最高
  owner_staff_code TEXT, owner_unit_code TEXT,
  due_date TEXT,
  status TEXT NOT NULL,                            -- 待處理 / 待匯出 / 已匯出 / 待回傳 / 已完成 / 已取消
  export_code TEXT,
  result TEXT, result_date TEXT, next_follow_date TEXT,
  dedupe_key TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks (owner_staff_code, status, due_date);
CREATE INDEX IF NOT EXISTS tasks_customer_idx ON tasks (customer_code, status);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status, due_date);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_open_dedupe_idx ON tasks (dedupe_key) WHERE dedupe_key IS NOT NULL AND status NOT IN ('已完成', '已取消');
CREATE TABLE IF NOT EXISTS task_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_code TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_value TEXT, to_value TEXT, note TEXT,
  actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_code, event_id);

CREATE TABLE IF NOT EXISTS export_batches (
  export_code TEXT PRIMARY KEY,
  list_version TEXT NOT NULL,
  data_date TEXT,
  task_count INTEGER NOT NULL,
  scope TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS result_batches (
  result_batch_code TEXT PRIMARY KEY,
  file_name TEXT, file_hash TEXT NOT NULL,
  total_rows INTEGER NOT NULL, applied INTEGER NOT NULL, unchanged INTEGER NOT NULL, rejected INTEGER NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS result_rows (
  result_batch_code TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  task_code TEXT, opp_code TEXT,
  row_hash TEXT,
  status TEXT NOT NULL,                            -- 已套用 / 無變更 / 拒絕
  message TEXT,
  PRIMARY KEY (result_batch_code, row_no)
);
CREATE INDEX IF NOT EXISTS result_rows_hash_idx ON result_rows (task_code, row_hash);

CREATE TABLE IF NOT EXISTS import_batches (
  batch_code TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  source_code TEXT NOT NULL,
  file_name TEXT, file_hash TEXT NOT NULL,
  data_date TEXT,
  status TEXT NOT NULL,                            -- 預覽 / 匯入中 / 已完成 / 已拒絕
  total_rows INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT
);
-- 匯入暫存：逐列驗證後才寫入正式表；同批次內相同鍵值視為檔案內重複。
CREATE TABLE IF NOT EXISTS import_staging (
  batch_code TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  row_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待處理',           -- 待處理 / 錯誤 / 已處理
  outcome TEXT,                                    -- 新增 / 更新 / 無變更
  PRIMARY KEY (batch_code, row_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS import_staging_key_idx ON import_staging (batch_code, row_key);

CREATE TABLE IF NOT EXISTS import_errors (
  batch_code TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  field TEXT,
  error_code TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS import_errors_batch_idx ON import_errors (batch_code, row_no);

CREATE TABLE IF NOT EXISTS automation_rules (
  rule_code TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,                        -- JSON：觸發、排除、任務內容、停止條件、頻率
  enabled INTEGER NOT NULL DEFAULT 0,
  is_current INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (rule_code, version)
);
CREATE TABLE IF NOT EXISTS automation_runs (
  run_code TEXT PRIMARY KEY,
  rule_code TEXT NOT NULL, rule_version INTEGER NOT NULL,
  mode TEXT NOT NULL,                              -- 試算 / 執行
  matched INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0,
  skipped_duplicate INTEGER NOT NULL DEFAULT 0, skipped_frequency INTEGER NOT NULL DEFAULT 0,
  skipped_stop INTEGER NOT NULL DEFAULT 0, skipped_complaint INTEGER NOT NULL DEFAULT 0,
  skipped_ineligible INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  started_by TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS score_overrides (
  customer_code TEXT NOT NULL,
  score_type TEXT NOT NULL,
  override_level TEXT NOT NULL,
  note TEXT,
  actor TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (customer_code, score_type)
);

CREATE TABLE IF NOT EXISTS app_users (
  email TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  app_role TEXT NOT NULL,                          -- sales / advisor / branch_manager / company_manager
  unit_code TEXT,
  staff_code TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_impersonation (
  real_email TEXT PRIMARY KEY,
  acting_email TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  acting_as TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_code TEXT,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_code);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS code_sequences (
  prefix TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL
);

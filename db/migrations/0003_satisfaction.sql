-- 0003_satisfaction: 滿意度問卷（CSI）。以車輛編碼串接；車牌須先在地端換成車輛編碼後才匯入。
CREATE TABLE IF NOT EXISTS satisfaction_surveys (
  survey_code TEXT PRIMARY KEY,
  vehicle_code TEXT,
  customer_code TEXT,
  survey_month TEXT,                               -- YYYYMM
  service_date TEXT,
  unit_code TEXT,
  advisor_code TEXT, technician_code TEXT,
  delivery_mode TEXT,                              -- 廠內等候 / 委託交車 / 自行取車
  first_visit INTEGER,
  service_category TEXT,                           -- 一般保修 / 保固 / 鈑噴
  score_overall REAL, score_repair REAL, score_checkout REAL, score_explain REAL, score_lounge REAL, score_total REAL,
  voc_text TEXT, voc_category TEXT,
  source_code TEXT, source_record_id TEXT, batch_code TEXT, data_date TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS satisfaction_vehicle_idx ON satisfaction_surveys (vehicle_code, service_date);
CREATE INDEX IF NOT EXISTS satisfaction_unit_idx ON satisfaction_surveys (unit_code, survey_month);

INSERT OR IGNORE INTO sources (source_code, name, entity, priority, description) VALUES
 ('CSI-SURVEY', 'CSI 滿意度問卷', 'satisfaction', 20, '問卷分數與客戶聲音；車牌於地端轉為車輛編碼'),
 ('CRM-COMPLAINT', '客訴紀錄', 'interactions', 20, '尚待地端提供（互動類型＝客訴）'),
 ('CRM-SALES', '購車／試乘／報價', 'interactions', 20, '尚待地端提供（互動類型＝試乘、報價；購車請以交易匯入）'),
 ('INS-POLICY', '保險保單', 'vehicles', 30, '尚待地端提供（保險到期日）');

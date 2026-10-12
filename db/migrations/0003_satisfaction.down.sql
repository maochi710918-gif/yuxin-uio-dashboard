-- Rollback for 0003_satisfaction.
DROP TABLE IF EXISTS satisfaction_surveys;
DELETE FROM sources WHERE source_code IN ('CSI-SURVEY', 'CRM-COMPLAINT', 'CRM-SALES', 'INS-POLICY') AND last_batch_code IS NULL;
DELETE FROM _migrations WHERE id = '0003_satisfaction';

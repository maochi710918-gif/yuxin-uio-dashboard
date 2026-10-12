-- Rollback for 0002_seed_rules: removes the seeded sources, preset segments and automation rules.
DELETE FROM automation_rules WHERE rule_code IN ('AR-MAINT', 'AR-WARRANTY', 'AR-INSURANCE', 'AR-DORMANT', 'AR-TESTDRIVE', 'AR-QUOTE', 'AR-REFERRAL') AND updated_by = 'system';
DELETE FROM segments WHERE is_preset = 1 AND created_by = 'system';
DELETE FROM sources WHERE source_code IN ('UIO-UNIT', 'UIO-STAFF', 'UIO-CUST', 'UIO-VEH', 'UIO-REL', 'UIO-VSTAFF', 'UIO-SUMMARY', 'DMS-REPAIR', 'DMS-SPEND', 'DMS-BEAUTY', 'CRM-INTERACTION', 'CRM-GROUP') AND last_batch_code IS NULL;
DELETE FROM _migrations WHERE id = '0002_seed_rules';

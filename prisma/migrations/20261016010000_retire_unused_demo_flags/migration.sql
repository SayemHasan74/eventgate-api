-- These retired flags are absent from the runtime schema. Preserve prior
-- classifications in the immutable audit history before dropping the columns.
DO $$
DECLARE target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['User', 'Event'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = current_schema() AND c.table_name = target_table AND c.column_name = 'isDemo') THEN
      EXECUTE format('INSERT INTO "AuditLog" ("id","action","entityType","entityId","metadata")
        SELECT gen_random_uuid(),''LEGACY_DEMO_CLASSIFICATION_ARCHIVED'',%L,"id",''{"isDemo":true}''::jsonb
        FROM %I WHERE "isDemo" = true', upper(target_table), target_table);
      EXECUTE format('ALTER TABLE %I DROP COLUMN "isDemo"', target_table);
    END IF;
  END LOOP;
END $$;

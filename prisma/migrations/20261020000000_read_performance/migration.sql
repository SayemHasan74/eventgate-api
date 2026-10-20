-- Ordered check-in history reads filter by event and paginate by admission time.
CREATE INDEX "Ticket_eventId_checkedInAt_id_idx" ON "Ticket"("eventId", "checkedInAt", "id");

-- Public substring searches use ILIKE. Ordinary B-tree indexes cannot support
-- the leading wildcard. pg_trgm is supported by PostgreSQL and Neon.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Event_public_title_trgm_idx" ON "Event" USING GIN ("title" gin_trgm_ops)
  WHERE "status" = 'PUBLISHED' AND "deletedAt" IS NULL;
CREATE INDEX "Event_public_description_trgm_idx" ON "Event" USING GIN ("description" gin_trgm_ops)
  WHERE "status" = 'PUBLISHED' AND "deletedAt" IS NULL;
CREATE INDEX "Event_public_category_trgm_idx" ON "Event" USING GIN ("category" gin_trgm_ops)
  WHERE "status" = 'PUBLISHED' AND "deletedAt" IS NULL;
CREATE INDEX "Event_public_city_trgm_idx" ON "Event" USING GIN ("city" gin_trgm_ops)
  WHERE "status" = 'PUBLISHED' AND "deletedAt" IS NULL;

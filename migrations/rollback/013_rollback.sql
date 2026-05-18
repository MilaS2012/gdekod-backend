-- ============================================================================
-- rollback 013 — снимает support_tickets и events_log.
-- ============================================================================

DROP INDEX IF EXISTS private_data.idx_events_type_created;
DROP INDEX IF EXISTS private_data.idx_events_user_type;
DROP INDEX IF EXISTS private_data.idx_events_created;
DROP TABLE IF EXISTS private_data.events_log CASCADE;

DROP INDEX IF EXISTS private_data.idx_tickets_status_created;
DROP INDEX IF EXISTS private_data.idx_tickets_user_created;
DROP TABLE IF EXISTS private_data.support_tickets CASCADE;

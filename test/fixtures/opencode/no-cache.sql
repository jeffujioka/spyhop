-- Synthetic opencode database from a version that logs no cache counts,
-- no variant, and has no `part` table: the cache figures and the autocompaction count have no
-- source (docs/opencode-session-format.md). Times are epoch ms from T0 = 1790000000000.
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
  directory text NOT NULL, title text NOT NULL, version text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer
);
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL
);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);

INSERT INTO session VALUES ('ses_legacy', 'prj', NULL, 's', '/work/legacy', 't', '0.9.0', 1790000000000, 1790000030000, NULL);
INSERT INTO message VALUES ('n01', 'ses_legacy', 1790000000000, 1790000000000, '{"role":"user"}');
INSERT INTO message VALUES ('n02', 'ses_legacy', 1790000001000, 1790000010000, '{"role":"assistant","parentID":"n01","modelID":"model-a","providerID":"p","cost":0.02,"tokens":{"total":370,"input":300,"output":70,"reasoning":0},"time":{"created":1790000001000,"completed":1790000010000}}');
INSERT INTO message VALUES ('n03', 'ses_legacy', 1790000020000, 1790000020000, '{"role":"user"}');
INSERT INTO message VALUES ('n04', 'ses_legacy', 1790000021000, 1790000030000, '{"role":"assistant","parentID":"n03","modelID":"model-a","providerID":"p","cost":0.03,"tokens":{"total":630,"input":500,"output":130,"reasoning":0},"time":{"created":1790000021000,"completed":1790000030000}}');

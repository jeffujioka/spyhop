-- Synthetic opencode database (schema subset of ~/.local/share/opencode/opencode.db, see
-- docs/opencode-session-format.md). Times are epoch ms from T0 = 1790000000000. No real paths,
-- ids or text. ses_basic: the session under test; its messages are
--   m01 user          +0
--   m02 assistant     +1000..+5000    model-a, low     in 100  out 50  rs 10  cr 0    cw 800  cost .10
--   m03 assistant     +5000..+9000    model-a, low     in 20   out 30  rs 0   cr 800  cw 100  cost .05
--   m04 user          +60000
--   m05 assistant     +61000..+70000  model-b, high    in 50   out 100 rs 20  cr 900  cw 0    cost .20
--   m06 user          +120000         compaction part, auto
--   m07 assistant     +121000..+125000 summary          in 1000 out 200 rs 0   cr 0    cw 0    cost .01
--   m08 user          +200000         compaction part, manual
--   m09 assistant     +201000..+205000 summary          in 100  out 20  rs 0   cr 0    cw 0    cost .01
--   m10 user          +300000         compaction part, auto
--   m11 assistant     +301000..+301300 summary, failed with ContextOverflowError, tokens 0, no total
--   m12 user          +498000
--   m13 assistant     +499000..+520000 model-b, high    in 10   out 40  rs 0   cr 400  cw 100  cost .04
-- Only m07 is a finished automatic compaction. ses_other, ses_child and ses_archived are other
-- sessions of the same folder or of another one.
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
  directory text NOT NULL, title text NOT NULL, version text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer,
  cost real DEFAULT 0 NOT NULL
);
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL
);
CREATE TABLE part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
CREATE INDEX part_session_idx ON part (session_id);

INSERT INTO session VALUES ('ses_basic', 'prj', NULL, 's', '/work/demo', 't', '1.0.0', 1790000000000, 1790000520000, NULL, 0.41);
INSERT INTO session VALUES ('ses_old', 'prj', NULL, 's', '/work/demo', 't', '1.0.0', 1789000000000, 1789000100000, NULL, 0);
INSERT INTO session VALUES ('ses_child', 'prj', 'ses_basic', 's', '/work/demo', 't', '1.0.0', 1790000100000, 1790000900000, NULL, 0);
INSERT INTO session VALUES ('ses_archived', 'prj', NULL, 's', '/work/demo', 't', '1.0.0', 1790000100000, 1790000950000, 1790000960000, 0);
INSERT INTO session VALUES ('ses_other', 'prj', NULL, 's', '/work/other', 't', '1.0.0', 1790000000000, 1790000300000, NULL, 0);

INSERT INTO message VALUES ('m01', 'ses_basic', 1790000000000, 1790000000000, '{"role":"user","agent":"build","model":{"providerID":"p","modelID":"model-a"}}');
INSERT INTO message VALUES ('m02', 'ses_basic', 1790000001000, 1790000005000, '{"role":"assistant","parentID":"m01","mode":"build","agent":"build","variant":"low","modelID":"model-a","providerID":"p","cost":0.10,"tokens":{"total":960,"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}},"time":{"created":1790000001000,"completed":1790000005000},"finish":"tool-calls"}');
INSERT INTO message VALUES ('m03', 'ses_basic', 1790000005000, 1790000009000, '{"role":"assistant","parentID":"m01","mode":"build","agent":"build","variant":"low","modelID":"model-a","providerID":"p","cost":0.05,"tokens":{"total":950,"input":20,"output":30,"reasoning":0,"cache":{"read":800,"write":100}},"time":{"created":1790000005000,"completed":1790000009000},"finish":"stop"}');
INSERT INTO message VALUES ('m04', 'ses_basic', 1790000060000, 1790000060000, '{"role":"user","agent":"build","model":{"providerID":"p","modelID":"model-b"},"summary":{"diffs":[]}}');
INSERT INTO message VALUES ('m05', 'ses_basic', 1790000061000, 1790000070000, '{"role":"assistant","parentID":"m04","mode":"build","agent":"build","variant":"high","modelID":"model-b","providerID":"p","cost":0.20,"tokens":{"total":1070,"input":50,"output":100,"reasoning":20,"cache":{"read":900,"write":0}},"time":{"created":1790000061000,"completed":1790000070000},"finish":"stop"}');
INSERT INTO message VALUES ('m06', 'ses_basic', 1790000120000, 1790000120000, '{"role":"user","agent":"build","model":{"providerID":"p","modelID":"model-b"}}');
INSERT INTO message VALUES ('m07', 'ses_basic', 1790000121000, 1790000125000, '{"role":"assistant","parentID":"m06","mode":"compaction","agent":"compaction","summary":true,"modelID":"model-c","providerID":"p","cost":0.01,"tokens":{"total":1200,"input":1000,"output":200,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1790000121000,"completed":1790000125000},"finish":"stop"}');
INSERT INTO message VALUES ('m08', 'ses_basic', 1790000200000, 1790000200000, '{"role":"user","agent":"build","model":{"providerID":"p","modelID":"model-b"}}');
INSERT INTO message VALUES ('m09', 'ses_basic', 1790000201000, 1790000205000, '{"role":"assistant","parentID":"m08","mode":"compaction","agent":"compaction","summary":true,"modelID":"model-c","providerID":"p","cost":0.01,"tokens":{"total":120,"input":100,"output":20,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1790000201000,"completed":1790000205000},"finish":"stop"}');
INSERT INTO message VALUES ('m10', 'ses_basic', 1790000300000, 1790000300000, '{"role":"user","agent":"build","model":{"providerID":"p","modelID":"model-b"}}');
INSERT INTO message VALUES ('m11', 'ses_basic', 1790000301000, 1790000301300, '{"role":"assistant","parentID":"m10","mode":"compaction","agent":"compaction","summary":true,"modelID":"model-c","providerID":"p","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1790000301000,"completed":1790000301300},"error":{"name":"ContextOverflowError","data":{"message":"x"}},"finish":"error"}');
INSERT INTO message VALUES ('m12', 'ses_basic', 1790000498000, 1790000498000, '{"role":"user","agent":"build","model":{"providerID":"p","modelID":"model-b"}}');
INSERT INTO message VALUES ('m13', 'ses_basic', 1790000499000, 1790000520000, '{"role":"assistant","parentID":"m12","mode":"build","agent":"build","variant":"high","modelID":"model-b","providerID":"p","cost":0.04,"tokens":{"total":550,"input":10,"output":40,"reasoning":0,"cache":{"read":400,"write":100}},"time":{"created":1790000499000,"completed":1790000520000},"finish":"stop"}');

INSERT INTO part VALUES ('p06', 'm06', 'ses_basic', 1790000120000, 1790000120000, '{"type":"compaction","auto":true,"overflow":true}');
INSERT INTO part VALUES ('p08', 'm08', 'ses_basic', 1790000200000, 1790000200000, '{"type":"compaction","auto":false}');
INSERT INTO part VALUES ('p10', 'm10', 'ses_basic', 1790000300000, 1790000300000, '{"type":"compaction","auto":true,"overflow":true}');
INSERT INTO part VALUES ('p13', 'm13', 'ses_basic', 1790000499000, 1790000499000, '{"type":"text","text":"x"}');

INSERT INTO message VALUES ('x01', 'ses_other', 1790000000000, 1790000000000, '{"role":"user"}');
INSERT INTO message VALUES ('x02', 'ses_other', 1790000001000, 1790000300000, '{"role":"assistant","parentID":"x01","modelID":"model-z","cost":0,"tokens":{"total":1,"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1790000001000,"completed":1790000300000}}');

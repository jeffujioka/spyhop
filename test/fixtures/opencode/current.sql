-- Synthetic opencode database with both generations of tables: the current `session_v2` and
-- `session_message`, and the legacy `session`, `message` and `part` (schema subsets of
-- ~/.local/share/opencode/opencode.db). The `data` of a current row is shaped as this Mac's
-- database holds it: an assistant row's model as `model.{id, providerID, variant}`, its tool
-- calls as `tool` items of `content` with `state.status`, its error as `error.type`, no token
-- total and no parent message; a compaction is a row of its own, with its model, cost and
-- tokens. A session row's `agent` is its agent kind and its `model` the JSON `{id, providerID,
-- variant}` (both null on the top-level sessions here). Times are epoch ms from
-- T0 = 1790000000000. No real paths, ids or text.
--   ses_current  /work/current      current only: claude-haiku-5.5, costs .30 and .14, four
--                                   `bash` tool items, one of them `error`
--   ses_legacy   /work/legacy       legacy only: cost .10
--   ses_both     /work/both         in both: .44 in the current tables, .10 in the legacy ones
--   ses_logged   /work/logged       current only: rows of costs .30 and .14 below the session's
--                                   own `cost` of .50, as opencode logs some sessions
--   ses_twin     /work/twin         current only, and ses_twin_legacy /work/twin-legacy, legacy
--                                   only: one session written in each generation's shape
--     user          +0
--     assistant     +1000..+5000    claude-haiku-5.5, high  in 100  out 50  rs 10 cr 0   cw 800  cost .30
--                                   tools bash completed, bash error
--     compaction    +61000           auto, model-c          in 1000 out 200 rs 0  cr 0   cw 0    cost .01
--                                   (legacy: a user message with an auto compaction part at
--                                   +60000 and its summary message)
--     user          +120000
--     assistant     +121000..+130000 claude-haiku-5.5, high in 20   out 30  rs 0  cr 800 cw 100  cost .14
--                                   tools bash completed, read completed
--   ses_p        /work/parent       current only: cost 1.00, and its sub-agents ses_c (parent
--                                   ses_p, `general`, claude-haiku-5.5, cost .40) and ses_g
--                                   (parent ses_c, `explore`, no `model`, cost .10)
--   ses_legacy_p /work/legacy-parent legacy only: cost .10, and its sub-agent ses_legacy_c
--                                   (parent ses_legacy_p, `Fix the build`, model-a, cost .05);
--                                   the legacy `session` here has no `agent` or `model`, as in
--                                   older opencode databases
CREATE TABLE session_v2 (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL,
  directory text NOT NULL, title text, version text NOT NULL, cost real DEFAULT 0 NOT NULL,
  agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL,
  time_archived integer
);
CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
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

INSERT INTO session_v2 VALUES ('ses_current', 'prj', NULL, 's', '/work/current', 't', '2.0.0', 0.44, NULL, NULL, 1790000000000, 1790000130000, NULL);
INSERT INTO session_message VALUES ('c01', 'ses_current', 'user', 1, 1790000000000, 1790000000000, '{"time":{"created":1790000000000},"text":"x"}');
INSERT INTO session_message VALUES ('c02', 'ses_current', 'assistant', 2, 1790000001000, 1790000005000, '{"time":{"created":1790000001000,"completed":1790000005000},"agent":"build","model":{"id":"claude-haiku-5.5","providerID":"p","variant":"high"},"content":[{"type":"text","text":"x"},{"type":"tool","id":"t1","name":"bash","state":{"status":"completed"}},{"type":"tool","id":"t2","name":"bash","state":{"status":"completed"}},{"type":"tool","id":"t3","name":"bash","state":{"status":"error"}}],"finish":"tool-calls","cost":0.30,"tokens":{"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}}}');
INSERT INTO session_message VALUES ('c03', 'ses_current', 'user', 3, 1790000120000, 1790000120000, '{"time":{"created":1790000120000},"text":"x"}');
INSERT INTO session_message VALUES ('c04', 'ses_current', 'assistant', 4, 1790000121000, 1790000130000, '{"time":{"created":1790000121000,"completed":1790000130000},"agent":"build","model":{"id":"claude-haiku-5.5","providerID":"p","variant":"high"},"content":[{"type":"tool","id":"t4","name":"bash","state":{"status":"completed"}}],"finish":"stop","cost":0.14,"tokens":{"input":20,"output":30,"reasoning":0,"cache":{"read":800,"write":100}}}');
-- rows of other types, which carry no figure
INSERT INTO session_message VALUES ('c05', 'ses_current', 'idle', 5, 1790000130000, 1790000130000, '{"time":{"created":1790000130000},"outcome":"x"}');

INSERT INTO session VALUES ('ses_legacy', 'prj', NULL, 's', '/work/legacy', 't', '1.0.0', 1790000000000, 1790000005000, NULL, 0.10);
INSERT INTO message VALUES ('l01', 'ses_legacy', 1790000000000, 1790000000000, '{"role":"user"}');
INSERT INTO message VALUES ('l02', 'ses_legacy', 1790000001000, 1790000005000, '{"role":"assistant","parentID":"l01","modelID":"model-a","providerID":"p","cost":0.10,"tokens":{"total":960,"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}},"time":{"created":1790000001000,"completed":1790000005000}}');

INSERT INTO session_v2 VALUES ('ses_both', 'prj', NULL, 's', '/work/both', 't', '2.0.0', 0.44, NULL, NULL, 1790000000000, 1790000005000, NULL);
INSERT INTO session_message VALUES ('b01', 'ses_both', 'user', 1, 1790000000000, 1790000000000, '{"time":{"created":1790000000000},"text":"x"}');
INSERT INTO session_message VALUES ('b02', 'ses_both', 'assistant', 2, 1790000001000, 1790000005000, '{"time":{"created":1790000001000,"completed":1790000005000},"model":{"id":"claude-haiku-5.5","providerID":"p"},"content":[],"cost":0.44,"tokens":{"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}}}');
INSERT INTO session VALUES ('ses_both', 'prj', NULL, 's', '/work/both', 't', '1.0.0', 1790000000000, 1790000005000, NULL, 0.10);
INSERT INTO message VALUES ('b11', 'ses_both', 1790000000000, 1790000000000, '{"role":"user"}');
INSERT INTO message VALUES ('b12', 'ses_both', 1790000001000, 1790000005000, '{"role":"assistant","parentID":"b11","modelID":"model-a","providerID":"p","cost":0.10,"tokens":{"total":960,"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}},"time":{"created":1790000001000,"completed":1790000005000}}');

INSERT INTO session_v2 VALUES ('ses_twin', 'prj', NULL, 's', '/work/twin', 't', '2.0.0', 0.45, NULL, NULL, 1790000000000, 1790000130000, NULL);
INSERT INTO session_message VALUES ('w01', 'ses_twin', 'user', 1, 1790000000000, 1790000000000, '{"time":{"created":1790000000000},"text":"x"}');
INSERT INTO session_message VALUES ('w02', 'ses_twin', 'assistant', 2, 1790000001000, 1790000005000, '{"time":{"created":1790000001000,"completed":1790000005000},"agent":"build","model":{"id":"claude-haiku-5.5","providerID":"p","variant":"high"},"content":[{"type":"tool","id":"t1","name":"bash","state":{"status":"completed"}},{"type":"tool","id":"t2","name":"bash","state":{"status":"error"}}],"finish":"tool-calls","cost":0.30,"tokens":{"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}}}');
INSERT INTO session_message VALUES ('w03', 'ses_twin', 'compaction', 3, 1790000061000, 1790000061000, '{"time":{"created":1790000061000},"status":"completed","reason":"auto","model":{"id":"model-c","providerID":"p"},"summary":"x","recent":"x","cost":0.01,"tokens":{"input":1000,"output":200,"reasoning":0,"cache":{"read":0,"write":0}}}');
INSERT INTO session_message VALUES ('w04', 'ses_twin', 'user', 4, 1790000120000, 1790000120000, '{"time":{"created":1790000120000},"text":"x"}');
INSERT INTO session_message VALUES ('w05', 'ses_twin', 'assistant', 5, 1790000121000, 1790000130000, '{"time":{"created":1790000121000,"completed":1790000130000},"agent":"build","model":{"id":"claude-haiku-5.5","providerID":"p","variant":"high"},"content":[{"type":"tool","id":"t3","name":"bash","state":{"status":"completed"}},{"type":"tool","id":"t4","name":"read","state":{"status":"completed"}}],"finish":"stop","cost":0.14,"tokens":{"input":20,"output":30,"reasoning":0,"cache":{"read":800,"write":100}}}');

INSERT INTO session VALUES ('ses_twin_legacy', 'prj', NULL, 's', '/work/twin-legacy', 't', '1.0.0', 1790000000000, 1790000130000, NULL, 0.45);
INSERT INTO message VALUES ('v01', 'ses_twin_legacy', 1790000000000, 1790000000000, '{"role":"user"}');
INSERT INTO message VALUES ('v02', 'ses_twin_legacy', 1790000001000, 1790000005000, '{"role":"assistant","parentID":"v01","variant":"high","modelID":"claude-haiku-5.5","providerID":"p","cost":0.30,"tokens":{"total":960,"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}},"time":{"created":1790000001000,"completed":1790000005000},"finish":"tool-calls"}');
INSERT INTO message VALUES ('v03', 'ses_twin_legacy', 1790000060000, 1790000060000, '{"role":"user"}');
INSERT INTO message VALUES ('v04', 'ses_twin_legacy', 1790000061000, 1790000061000, '{"role":"assistant","parentID":"v03","mode":"compaction","summary":true,"modelID":"model-c","providerID":"p","cost":0.01,"tokens":{"total":1200,"input":1000,"output":200,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1790000061000,"completed":1790000061000},"finish":"stop"}');
INSERT INTO message VALUES ('v05', 'ses_twin_legacy', 1790000120000, 1790000120000, '{"role":"user"}');
INSERT INTO message VALUES ('v06', 'ses_twin_legacy', 1790000121000, 1790000130000, '{"role":"assistant","parentID":"v05","variant":"high","modelID":"claude-haiku-5.5","providerID":"p","cost":0.14,"tokens":{"total":950,"input":20,"output":30,"reasoning":0,"cache":{"read":800,"write":100}},"time":{"created":1790000121000,"completed":1790000130000},"finish":"stop"}');
INSERT INTO part VALUES ('q01', 'v02', 'ses_twin_legacy', 1790000002000, 1790000002000, '{"type":"tool","callID":"t1","tool":"bash","state":{"status":"completed"}}');
INSERT INTO part VALUES ('q02', 'v02', 'ses_twin_legacy', 1790000003000, 1790000003000, '{"type":"tool","callID":"t2","tool":"bash","state":{"status":"error"}}');
INSERT INTO part VALUES ('q03', 'v03', 'ses_twin_legacy', 1790000060000, 1790000060000, '{"type":"compaction","auto":true}');
INSERT INTO part VALUES ('q04', 'v06', 'ses_twin_legacy', 1790000122000, 1790000122000, '{"type":"tool","callID":"t3","tool":"bash","state":{"status":"completed"}}');
INSERT INTO part VALUES ('q05', 'v06', 'ses_twin_legacy', 1790000123000, 1790000123000, '{"type":"tool","callID":"t4","tool":"read","state":{"status":"completed"}}');

INSERT INTO session_v2 VALUES ('ses_logged', 'prj', NULL, 's', '/work/logged', 't', '2.0.0', 0.50, NULL, NULL, 1790000000000, 1790000130000, NULL);
INSERT INTO session_message VALUES ('g01', 'ses_logged', 'user', 1, 1790000000000, 1790000000000, '{"time":{"created":1790000000000},"text":"x"}');
INSERT INTO session_message VALUES ('g02', 'ses_logged', 'assistant', 2, 1790000001000, 1790000005000, '{"time":{"created":1790000001000,"completed":1790000005000},"model":{"id":"claude-haiku-5.5","providerID":"p"},"content":[],"cost":0.30,"tokens":{"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}}}');
INSERT INTO session_message VALUES ('g03', 'ses_logged', 'user', 3, 1790000120000, 1790000120000, '{"time":{"created":1790000120000},"text":"x"}');
INSERT INTO session_message VALUES ('g04', 'ses_logged', 'assistant', 4, 1790000121000, 1790000130000, '{"time":{"created":1790000121000,"completed":1790000130000},"model":{"id":"claude-haiku-5.5","providerID":"p"},"content":[],"cost":0.14,"tokens":{"input":20,"output":30,"reasoning":0,"cache":{"read":800,"write":100}}}');

INSERT INTO session_v2 VALUES ('ses_p', 'prj', NULL, 's', '/work/parent', 't', '2.0.0', 1.00, NULL, NULL, 1790000000000, 1790000300000, NULL);
INSERT INTO session_message VALUES ('p01', 'ses_p', 'user', 1, 1790000000000, 1790000000000, '{"time":{"created":1790000000000},"text":"x"}');
INSERT INTO session_message VALUES ('p02', 'ses_p', 'assistant', 2, 1790000001000, 1790000300000, '{"time":{"created":1790000001000,"completed":1790000300000},"agent":"build","model":{"id":"claude-haiku-5.5","providerID":"p","variant":"high"},"content":[{"type":"tool","id":"t1","name":"task","state":{"status":"completed"}}],"finish":"stop","cost":1.00,"tokens":{"input":100,"output":50,"reasoning":0,"cache":{"read":0,"write":800}}}');
INSERT INTO session_v2 VALUES ('ses_c', 'prj', 'ses_p', 's', '/work/parent', 'Explore the repo', '2.0.0', 0.40, 'general', '{"id":"claude-haiku-5.5","providerID":"p","variant":"high"}', 1790000010000, 1790000200000, NULL);
INSERT INTO session_message VALUES ('k01', 'ses_c', 'user', 1, 1790000010000, 1790000010000, '{"time":{"created":1790000010000},"text":"x"}');
INSERT INTO session_message VALUES ('k02', 'ses_c', 'assistant', 2, 1790000011000, 1790000200000, '{"time":{"created":1790000011000,"completed":1790000200000},"agent":"general","model":{"id":"claude-haiku-5.5","providerID":"p","variant":"high"},"content":[{"type":"tool","id":"t1","name":"read","state":{"status":"completed"}}],"finish":"stop","cost":0.40,"tokens":{"input":100,"output":50,"reasoning":0,"cache":{"read":0,"write":800}}}');
INSERT INTO session_v2 VALUES ('ses_g', 'prj', 'ses_c', 's', '/work/parent', 'Read the docs', '2.0.0', 0.10, 'explore', NULL, 1790000020000, 1790000100000, NULL);
INSERT INTO session_message VALUES ('j01', 'ses_g', 'user', 1, 1790000020000, 1790000020000, '{"time":{"created":1790000020000},"text":"x"}');
INSERT INTO session_message VALUES ('j02', 'ses_g', 'assistant', 2, 1790000021000, 1790000100000, '{"time":{"created":1790000021000,"completed":1790000100000},"agent":"explore","model":{"id":"claude-haiku-5.5","providerID":"p","variant":"high"},"content":[],"finish":"stop","cost":0.10,"tokens":{"input":100,"output":50,"reasoning":0,"cache":{"read":0,"write":800}}}');

INSERT INTO session VALUES ('ses_legacy_p', 'prj', NULL, 's', '/work/legacy-parent', 't', '1.0.0', 1790000000000, 1790000300000, NULL, 0.10);
INSERT INTO message VALUES ('lp1', 'ses_legacy_p', 1790000000000, 1790000000000, '{"role":"user"}');
INSERT INTO message VALUES ('lp2', 'ses_legacy_p', 1790000001000, 1790000300000, '{"role":"assistant","parentID":"lp1","modelID":"model-a","providerID":"p","cost":0.10,"tokens":{"total":960,"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}},"time":{"created":1790000001000,"completed":1790000300000}}');
INSERT INTO session VALUES ('ses_legacy_c', 'prj', 'ses_legacy_p', 's', '/work/legacy-parent', 'Fix the build', '1.0.0', 1790000010000, 1790000200000, NULL, 0.05);
INSERT INTO message VALUES ('lc1', 'ses_legacy_c', 1790000010000, 1790000010000, '{"role":"user"}');
INSERT INTO message VALUES ('lc2', 'ses_legacy_c', 1790000011000, 1790000200000, '{"role":"assistant","parentID":"lc1","agent":"general","modelID":"model-a","providerID":"p","cost":0.05,"tokens":{"total":960,"input":100,"output":50,"reasoning":10,"cache":{"read":0,"write":800}},"time":{"created":1790000011000,"completed":1790000200000}}');
INSERT INTO part VALUES ('lq1', 'lc2', 'ses_legacy_c', 1790000012000, 1790000012000, '{"type":"tool","callID":"t1","tool":"read","state":{"status":"completed"}}');

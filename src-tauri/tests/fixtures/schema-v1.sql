CREATE TABLE installations (
    agent_id TEXT PRIMARY KEY NOT NULL,
    version TEXT NOT NULL,
    artifact TEXT NOT NULL,
    definition TEXT NOT NULL
);
INSERT INTO installations VALUES ('codex', '1.12.0', '/installed/codex', '{"id":"codex","name":"Codex","command":"/installed/node","args":["/installed/codex/adapter.js"],"env":{}}');
PRAGMA user_version = 1;

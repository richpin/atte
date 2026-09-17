ALTER TABLE installations ADD COLUMN source TEXT;
CREATE TABLE registry_cache (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    document TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
UPDATE installations SET agent_id = agent_id || '-acp', definition = json_set(definition, '$.id', agent_id || '-acp')
WHERE agent_id IN ('claude', 'codex', 'antigravity');
PRAGMA user_version = 2;

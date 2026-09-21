CREATE TABLE agents (
    id TEXT PRIMARY KEY NOT NULL,
    registry_metadata TEXT,
    installed_version TEXT,
    artifact_path TEXT,
    pending_artifact_path TEXT,
    launch_definition TEXT,
    CHECK ((installed_version IS NULL AND artifact_path IS NULL AND launch_definition IS NULL)
        OR (installed_version IS NOT NULL AND artifact_path IS NOT NULL AND launch_definition IS NOT NULL))
);
CREATE TABLE app_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
-- Unsent input belongs to the thread; array order is FIFO.
CREATE TABLE threads (
    id TEXT PRIMARY KEY NOT NULL,
    metadata TEXT NOT NULL,
    queued_messages TEXT NOT NULL DEFAULT '[]'
) STRICT;
PRAGMA user_version = 1;

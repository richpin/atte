CREATE TABLE agents (
    id TEXT PRIMARY KEY NOT NULL,
    registry_metadata TEXT,
    installed_version TEXT,
    artifact_path TEXT,
    launch_definition TEXT,
    CHECK ((installed_version IS NULL AND artifact_path IS NULL AND launch_definition IS NULL)
        OR (installed_version IS NOT NULL AND artifact_path IS NOT NULL AND launch_definition IS NOT NULL))
);
CREATE TABLE app_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
PRAGMA user_version = 1;

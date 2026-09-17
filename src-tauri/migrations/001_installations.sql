CREATE TABLE installations (
    agent_id TEXT PRIMARY KEY NOT NULL,
    version TEXT NOT NULL,
    artifact TEXT NOT NULL,
    definition TEXT NOT NULL
);
PRAGMA user_version = 1;

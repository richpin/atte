-- Only list/reconnection metadata, never transcript or permission payloads.
CREATE TABLE conversations (
    id TEXT PRIMARY KEY NOT NULL,
    metadata TEXT NOT NULL
) STRICT;
PRAGMA user_version = 2;

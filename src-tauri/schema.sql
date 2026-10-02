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
    title TEXT NOT NULL,
    working_folder TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    last_prompt_at INTEGER CHECK (last_prompt_at >= 0),
    status TEXT NOT NULL CHECK (status IN (
        'disconnected',
        'connecting',
        'sessionReady',
        'running',
        'waitingForApproval',
        'cancelling',
        'failed'
    )),
    failure TEXT CHECK (failure IS NULL OR failure IN (
        'executableNotFound',
        'launchFailed',
        'initializationFailed',
        'sessionCreationFailed',
        'authenticationRequired',
        'processExited',
        'connectionClosed',
        'timedOut',
        'promptFailed',
        'agentRemoved',
        'resumptionUnsupported',
        'sessionRestorationFailed'
    )),
    interrupted INTEGER NOT NULL CHECK (interrupted IN (0, 1)),
    queued_messages TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(queued_messages) AND json_type(queued_messages) = 'array')
) STRICT;
PRAGMA user_version = 1;

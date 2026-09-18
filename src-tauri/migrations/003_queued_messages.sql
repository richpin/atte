-- Only Atte-owned unsent input; array order is submission order.
CREATE TABLE conversation_queues (
    conversation_id TEXT PRIMARY KEY NOT NULL,
    messages TEXT NOT NULL
) STRICT;
PRAGMA user_version = 3;

ALTER TABLE conversations ADD COLUMN queued_messages TEXT NOT NULL DEFAULT '[]';
UPDATE conversations
SET queued_messages = conversation_queues.messages
FROM conversation_queues
WHERE conversations.id = conversation_queues.conversation_id;
DROP TABLE conversation_queues;
PRAGMA user_version = 4;

//! A load response commits this buffer; failed/partial replay never replaces history.
use crate::thread::{Attachment, Turn};
use agent_client_protocol::schema::v1::{ContentBlock, SessionUpdate};
use uuid::Uuid;

pub(super) struct Replay {
    pub turns: Vec<Turn>,
    user_chunk: bool,
    user_message_id: Option<String>,
}

impl Replay {
    pub fn new() -> Self {
        Self {
            turns: Vec::new(),
            user_chunk: false,
            user_message_id: None,
        }
    }

    pub fn update(&mut self, update: SessionUpdate) {
        match update {
            SessionUpdate::UserMessageChunk(chunk) => {
                let message_id = chunk.message_id.map(|id| id.to_string());
                if !self.user_chunk
                    || self.turns.is_empty()
                    || (message_id.is_some() && message_id != self.user_message_id)
                {
                    self.turns.push(Turn {
                        id: Uuid::new_v4(),
                        message: String::new(),
                        attachments: Vec::new(),
                        response: String::new(),
                        stop_reason: None,
                    });
                }
                if let Some(turn) = self.turns.last_mut() {
                    match chunk.content {
                        ContentBlock::Text(text) => turn.message.push_str(&text.text),
                        ContentBlock::ResourceLink(link) => turn.attachments.push(Attachment {
                            id: Uuid::new_v4(),
                            name: link.name,
                            uri: link.uri,
                        }),
                        _ => {}
                    }
                }
                self.user_chunk = true;
                self.user_message_id = message_id;
            }
            SessionUpdate::AgentMessageChunk(chunk) => {
                if self.turns.is_empty() {
                    self.turns.push(Turn {
                        id: Uuid::new_v4(),
                        message: String::new(),
                        attachments: Vec::new(),
                        response: String::new(),
                        stop_reason: None,
                    });
                }
                if let (Some(turn), ContentBlock::Text(text)) =
                    (self.turns.last_mut(), chunk.content)
                {
                    turn.response.push_str(&text.text);
                }
                self.user_chunk = false;
            }
            _ => {}
        }
    }
}

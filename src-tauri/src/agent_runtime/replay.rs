//! A load response commits this buffer; failed/partial replay never replaces history.
use crate::thread::{Attachment, MediaKind, Turn};
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
                        response_parts: Vec::new(),
                        stop_reason: None,
                    });
                }
                if let Some(turn) = self.turns.last_mut() {
                    match chunk.content {
                        ContentBlock::Text(text) => turn.message.push_str(&text.text),
                        ContentBlock::ResourceLink(link) => turn
                            .attachments
                            .push(Attachment::file(Uuid::new_v4(), link.name, link.uri)),
                        ContentBlock::Image(image) => turn.attachments.push(Attachment::media(
                            Uuid::new_v4(),
                            attachment_name(image.meta.as_ref(), "Image"),
                            MediaKind::Image,
                            image.mime_type,
                        )),
                        ContentBlock::Audio(audio) => turn.attachments.push(Attachment::media(
                            Uuid::new_v4(),
                            attachment_name(audio.meta.as_ref(), "Audio"),
                            MediaKind::Audio,
                            audio.mime_type,
                        )),
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
                        response_parts: Vec::new(),
                        stop_reason: None,
                    });
                }
                if let (Some(turn), ContentBlock::Text(text)) =
                    (self.turns.last_mut(), chunk.content)
                {
                    turn.append_response_text(&text.text);
                }
                self.user_chunk = false;
            }
            SessionUpdate::ToolCall(tool) => self.update_tool(tool.into()),
            SessionUpdate::ToolCallUpdate(tool) => self.update_tool(tool),
            _ => {}
        }
    }

    fn update_tool(&mut self, tool: agent_client_protocol::schema::v1::ToolCallUpdate) {
        if self.turns.is_empty() {
            self.turns.push(Turn {
                id: Uuid::new_v4(),
                message: String::new(),
                attachments: Vec::new(),
                response_parts: Vec::new(),
                stop_reason: None,
            });
        }
        if let Some(turn) = self.turns.last_mut() {
            turn.update_tool(tool);
        }
        self.user_chunk = false;
    }
}

fn attachment_name(
    meta: Option<&agent_client_protocol::schema::v1::Meta>,
    fallback: &str,
) -> String {
    meta.and_then(|meta| meta.get("atte/name"))
        .and_then(|name| name.as_str())
        .unwrap_or(fallback)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_only_replies_separate_identical_user_messages_and_restore_updates() {
        let mut replay = Replay::new();
        for update in [
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Again"}}),
            json!({"sessionUpdate":"tool_call","toolCallId":"a","title":"Read","status":"in_progress"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"completed"}),
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Again"}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"b","title":"Search","status":"completed"}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Found it"}}),
        ] {
            replay.update(serde_json::from_value(update).unwrap());
        }
        assert_eq!(replay.turns.len(), 2);
        let value = serde_json::to_value(&replay.turns).unwrap();
        assert_eq!(value[0]["responseParts"][0]["tool"]["status"], "completed");
        assert_eq!(value[1]["responseParts"][0]["id"], "b");
        assert_eq!(value[1]["responseParts"][1]["text"], "Found it");
    }
}

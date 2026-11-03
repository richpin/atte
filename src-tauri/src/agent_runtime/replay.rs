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
            SessionUpdate::PlanUpdate(update) => {
                if let Some((plan_id, content)) = super::plan::plan_content(update) {
                    if self.turns.is_empty() {
                        self.turns.push(Turn {
                            id: Uuid::new_v4(),
                            message: String::new(),
                            attachments: Vec::new(),
                            response_parts: Vec::new(),
                            stop_reason: None,
                        });
                    }
                    let current = self.turns.last().map(|turn| turn.id);
                    crate::thread::update_plan_content(
                        &mut self.turns,
                        current,
                        plan_id,
                        Some(content),
                    );
                    self.user_chunk = false;
                }
            }
            SessionUpdate::PlanRemoved(removed) => {
                crate::thread::update_plan_content(
                    &mut self.turns,
                    None,
                    removed.plan_id.to_string(),
                    None,
                );
                self.user_chunk = false;
            }
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
                        ContentBlock::Text(text) => {
                            if let Some(resources) = text
                                .meta
                                .as_ref()
                                .and_then(|m| m.get("atte/resources"))
                                .and_then(|v| {
                                    serde_json::from_value::<Vec<Attachment>>(v.clone()).ok()
                                })
                            {
                                let offset = turn.message.encode_utf16().count();
                                let body = text.text.encode_utf16().collect::<Vec<_>>();
                                for mut attachment in resources {
                                    if let Some(resource) = &mut attachment.resource {
                                        resource.embedded = false;
                                        resource.mentions.retain(|m| {
                                            m.start < m.end
                                                && m.end <= body.len()
                                                && body[m.start..m.end]
                                                    == format!("@{}", m.path)
                                                        .encode_utf16()
                                                        .collect::<Vec<_>>()
                                        });
                                        for mention in &mut resource.mentions {
                                            mention.start += offset;
                                            mention.end += offset;
                                        }
                                        if !resource.mentions.is_empty() {
                                            turn.attachments.push(attachment);
                                        }
                                    }
                                }
                            }
                            turn.message.push_str(&text.text);
                        }
                        ContentBlock::ResourceLink(link) => {
                            if !turn
                                .attachments
                                .iter()
                                .any(|a| a.uri.as_deref() == Some(link.uri.as_str()))
                            {
                                turn.attachments.push(Attachment::file(
                                    Uuid::new_v4(),
                                    link.name,
                                    link.uri,
                                ));
                            }
                        }
                        ContentBlock::Resource(resource) => {
                            let uri = match resource.resource {
                                agent_client_protocol::schema::v1::EmbeddedResourceResource::TextResourceContents(r) => r.uri,
                                agent_client_protocol::schema::v1::EmbeddedResourceResource::BlobResourceContents(r) => r.uri,
                                _ => return,
                            };
                            if !turn
                                .attachments
                                .iter()
                                .any(|a| a.uri.as_deref() == Some(uri.as_str()))
                            {
                                let name = uri.rsplit('/').next().unwrap_or("Resource").to_string();
                                turn.attachments
                                    .push(Attachment::file(Uuid::new_v4(), name, uri));
                            }
                        }
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
                if let Some(turn) = self.turns.last_mut() {
                    turn.append_message(chunk);
                }
                self.user_chunk = false;
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
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
                    turn.append_thought(&text.text, chunk.message_id.map(|id| id.to_string()));
                }
                self.user_chunk = false;
            }
            SessionUpdate::Plan(plan) => {
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
                    turn.update_plan(plan);
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
    fn thought_only_replies_separate_turns_even_without_a_user_message() {
        let mut replay = Replay::new();
        for update in [
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"First"}}),
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Again"}}),
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Second"}}),
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Again"}}),
        ] {
            replay.update(serde_json::from_value(update).unwrap());
        }
        let turns = serde_json::to_value(&replay.turns).unwrap();
        assert_eq!(replay.turns.len(), 3);
        assert_eq!(turns[0]["responseParts"][0]["text"], "First");
        assert_eq!(turns[1]["responseParts"][0]["text"], "Second");
        assert!(replay.turns[2].response_parts.is_empty());
    }

    #[test]
    fn plan_only_replies_separate_turns_and_restore_the_final_snapshot() {
        let mut replay = Replay::new();
        for update in [
            json!({"sessionUpdate":"plan","entries":[{"content":"Initial","priority":"high","status":"pending"}]}),
            json!({"sessionUpdate":"plan","entries":[{"content":"Initial","priority":"high","status":"completed"}]}),
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Next"}}),
            json!({"sessionUpdate":"plan","entries":[{"content":"Next task","priority":"low","status":"in_progress"}]}),
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Next"}}),
        ] {
            replay.update(serde_json::from_value(update).unwrap());
        }
        let turns = serde_json::to_value(&replay.turns).unwrap();
        assert_eq!(replay.turns.len(), 3);
        assert_eq!(turns[0]["responseParts"].as_array().unwrap().len(), 1);
        assert_eq!(
            turns[0]["responseParts"][0]["plan"]["entries"][0]["status"],
            "completed"
        );
        assert_eq!(
            turns[1]["responseParts"][0]["plan"]["entries"][0]["content"],
            "Next task"
        );
        assert!(replay.turns[2].response_parts.is_empty());
    }

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

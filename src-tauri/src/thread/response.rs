//! Ordered response content shared by live notifications and history replay.
use super::Turn;
use agent_client_protocol::schema::v1::{Plan, ToolCallUpdate, ToolCallUpdateFields};
use serde::Serialize;
use uuid::Uuid;

/// Application-owned representation of the ACP v1 draft plan formats.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlanContent {
    Items {
        entries: Vec<agent_client_protocol::schema::v1::PlanEntry>,
    },
    Markdown {
        content: String,
    },
    File {
        uri: String,
    },
}

/// Replace a session-scoped plan at its original transcript position.
/// Removed plans retain their slot so restoration preserves identity.
pub(crate) fn update_plan_content(
    turns: &mut [Turn],
    current_turn: Option<Uuid>,
    plan_id: String,
    content: Option<PlanContent>,
) -> Option<(Uuid, ResponsePart)> {
    for turn in turns.iter_mut() {
        if let Some(part) = turn.response_parts.iter_mut().find(|part| {
            matches!(part, ResponsePart::PlanContent { plan_id: existing, .. } if existing == &plan_id)
        }) {
            if let ResponsePart::PlanContent { content: previous, .. } = part {
                *previous = content;
            }
            return Some((turn.id, part.clone()));
        }
    }
    let content = content?;
    let turn = turns
        .iter_mut()
        .find(|turn| Some(turn.id) == current_turn)?;
    let part = ResponsePart::PlanContent {
        id: Uuid::new_v4().to_string(),
        plan_id,
        content: Some(content),
    };
    turn.response_parts.push(part.clone());
    Some((turn.id, part))
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResponsePart {
    Text {
        id: String,
        text: String,
    },
    Thought {
        id: String,
        text: String,
        #[serde(skip)]
        message_id: Option<String>,
    },
    Plan {
        id: String,
        plan: Plan,
    },
    PlanContent {
        id: String,
        #[serde(rename = "planId")]
        plan_id: String,
        content: Option<PlanContent>,
    },
    Tool {
        id: String,
        tool: Box<ToolCallUpdateFields>,
    },
}

impl Turn {
    /// Append consecutive text to one part; activity forms boundaries between text parts.
    pub fn append_response_text(&mut self, text: &str) -> String {
        if let Some(ResponsePart::Text { id, text: previous }) = self.response_parts.last_mut() {
            previous.push_str(text);
            return id.clone();
        }
        let id = Uuid::new_v4().to_string();
        self.response_parts.push(ResponsePart::Text {
            id: id.clone(),
            text: text.to_owned(),
        });
        id
    }

    /// Append published reasoning, retaining its message identity only in the backend.
    pub fn append_thought(&mut self, text: &str, message_id: Option<String>) -> Option<String> {
        if text.is_empty() {
            return None;
        }
        if let Some(ResponsePart::Thought {
            id,
            text: previous,
            message_id: known,
        }) = self.response_parts.last_mut()
        {
            if message_id.is_none() || known.is_none() || message_id == *known {
                previous.push_str(text);
                if message_id.is_some() {
                    *known = message_id;
                }
                return Some(id.clone());
            }
        }
        let id = Uuid::new_v4().to_string();
        self.response_parts.push(ResponsePart::Thought {
            id: id.clone(),
            text: text.to_owned(),
            message_id,
        });
        Some(id)
    }

    /// Apply a partial ACP update in place, preserving the call's original position.
    pub fn update_tool(&mut self, update: ToolCallUpdate) -> ResponsePart {
        let id = update.tool_call_id.to_string();
        let index = self.response_parts.iter().position(
            |part| matches!(part, ResponsePart::Tool { id: existing, .. } if existing == &id),
        );
        let index = index.unwrap_or_else(|| {
            self.response_parts.push(ResponsePart::Tool {
                id,
                tool: Box::default(),
            });
            self.response_parts.len() - 1
        });
        if let ResponsePart::Tool { tool, .. } = &mut self.response_parts[index] {
            let incoming = update.fields;
            if incoming.kind.is_some() {
                tool.kind = incoming.kind;
            }
            if incoming.status.is_some() {
                tool.status = incoming.status;
            }
            if incoming.title.is_some() {
                tool.title = incoming.title;
            }
            if incoming.content.is_some() {
                tool.content = incoming.content;
            }
            if incoming.locations.is_some() {
                tool.locations = incoming.locations;
            }
            if incoming.raw_input.is_some() {
                tool.raw_input = incoming.raw_input;
            }
            if incoming.raw_output.is_some() {
                tool.raw_output = incoming.raw_output;
            }
        }
        self.response_parts[index].clone()
    }

    /// Replace the turn's plan snapshot while preserving its first position and identity.
    pub fn update_plan(&mut self, plan: Plan) -> ResponsePart {
        if let Some(part) = self
            .response_parts
            .iter_mut()
            .find(|part| matches!(part, ResponsePart::Plan { .. }))
        {
            if let ResponsePart::Plan { plan: previous, .. } = part {
                *previous = plan;
            }
            return part.clone();
        }
        let part = ResponsePart::Plan {
            id: Uuid::new_v4().to_string(),
            plan,
        };
        self.response_parts.push(part.clone());
        part
    }

    /// Text-only projection for consumers that do not render tool activity.
    pub fn response_text(&self) -> String {
        self.response_parts
            .iter()
            .filter_map(|part| match part {
                ResponsePart::Text { text, .. } => Some(text.as_str()),
                ResponsePart::Tool { .. }
                | ResponsePart::Plan { .. }
                | ResponsePart::PlanContent { .. }
                | ResponsePart::Thought { .. } => None,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn thoughts_group_by_known_message_and_do_not_leak_into_answers_or_wire_metadata() {
        let mut turn = Turn {
            id: Uuid::new_v4(),
            message: String::new(),
            attachments: Vec::new(),
            response_parts: Vec::new(),
            stop_reason: None,
        };
        assert_eq!(turn.append_thought("", Some("empty".into())), None);
        let first = turn.append_thought("One", Some("a".into()));
        assert_eq!(turn.append_thought(" plus", None), first);
        assert_eq!(turn.append_thought(" more", Some("a".into())), first);
        let second = turn.append_thought("Two", Some("b".into()));
        assert_ne!(second, first);
        turn.append_response_text("Answer");
        assert_ne!(turn.append_thought("Three", Some("b".into())), second);
        let value = serde_json::to_value(&turn.response_parts).unwrap();
        assert_eq!(value[0]["text"], "One plus more");
        assert!(value[0].get("message_id").is_none());
        assert!(value[0].get("messageId").is_none());
        assert_eq!(turn.response_text(), "Answer");
        assert_eq!(turn.response_parts.len(), 4);
    }

    #[test]
    fn plan_snapshots_replace_entries_at_the_first_position_even_after_clearing() {
        let mut turn = Turn {
            id: Uuid::new_v4(),
            message: String::new(),
            attachments: Vec::new(),
            response_parts: Vec::new(),
            stop_reason: None,
        };
        turn.append_response_text("Before");
        let initial = turn.update_plan(
            serde_json::from_value(json!({"entries":[
                {"content":"Read","priority":"high","status":"completed"},
                {"content":"Test","priority":"low","status":"pending"}
            ]}))
            .unwrap(),
        );
        turn.append_response_text("After");
        turn.update_plan(serde_json::from_value(json!({"entries":[]})).unwrap());
        let updated = turn.update_plan(
            serde_json::from_value(json!({"entries":[
                {"content":"Test","priority":"low","status":"in_progress"}
            ]}))
            .unwrap(),
        );
        let before = serde_json::to_value(initial).unwrap();
        let after = serde_json::to_value(updated).unwrap();
        assert_eq!(before["id"], after["id"]);
        assert_eq!(after["plan"]["entries"].as_array().unwrap().len(), 1);
        assert_eq!(turn.response_parts.len(), 3);
        assert_eq!(turn.response_text(), "BeforeAfter");
        assert_eq!(
            serde_json::to_value(&turn).unwrap()["responseParts"][1],
            after
        );
    }

    #[test]
    fn preserves_interleaving_when_parallel_tools_finish_out_of_order() {
        let mut turn = Turn {
            id: Uuid::new_v4(),
            message: String::new(),
            attachments: Vec::new(),
            response_parts: Vec::new(),
            stop_reason: None,
        };
        let first_text = turn.append_response_text("Before ");
        assert_eq!(turn.append_response_text("tools"), first_text);
        turn.update_tool(serde_json::from_value(json!({"toolCallId":"a","title":"Read file","kind":"read","status":"in_progress","rawInput":{"path":"file.rs"},"content":[{"type":"content","content":{"type":"text","text":"old"}}],"locations":[{"path":"/file.rs"}]})).unwrap());
        turn.update_tool(serde_json::from_value(json!({"toolCallId":"b","title":"Run tests","kind":"execute","status":"in_progress"})).unwrap());
        turn.append_response_text("After tools");
        turn.update_tool(
            serde_json::from_value(
                json!({"toolCallId":"b","status":"failed","rawOutput":"Tests failed"}),
            )
            .unwrap(),
        );
        turn.update_tool(
            serde_json::from_value(
                json!({"toolCallId":"a","status":"completed","content":[],"locations":[]}),
            )
            .unwrap(),
        );
        let value = serde_json::to_value(&turn).unwrap();
        assert_eq!(
            value["responseParts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|part| part["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["text", "tool", "tool", "text"]
        );
        assert_eq!(value["responseParts"][1]["tool"]["title"], "Read file");
        assert_eq!(
            value["responseParts"][1]["tool"]["rawInput"]["path"],
            "file.rs"
        );
        assert_eq!(value["responseParts"][1]["tool"]["status"], "completed");
        assert_eq!(value["responseParts"][1]["tool"]["content"], json!([]));
        assert_eq!(value["responseParts"][1]["tool"]["locations"], json!([]));
        assert_eq!(value["responseParts"][2]["tool"]["status"], "failed");
        assert_eq!(turn.response_text(), "Before toolsAfter tools");
    }

    #[test]
    fn accepts_updates_before_initial_call_without_duplicate_rows() {
        let mut turn = Turn {
            id: Uuid::new_v4(),
            message: String::new(),
            attachments: Vec::new(),
            response_parts: Vec::new(),
            stop_reason: None,
        };
        turn.update_tool(
            serde_json::from_value(json!({"toolCallId":"late","rawInput":"command"})).unwrap(),
        );
        turn.append_response_text("Progress");
        turn.update_tool(serde_json::from_value(json!({"toolCallId":"late","title":"Run command","status":"completed","rawInput":null})).unwrap());
        let value = serde_json::to_value(&turn).unwrap();
        assert_eq!(value["responseParts"].as_array().unwrap().len(), 2);
        assert_eq!(value["responseParts"][0]["id"], "late");
        assert_eq!(value["responseParts"][0]["tool"]["rawInput"], "command");
    }
}

//! Ordered response content shared by live notifications and history replay.
use super::Turn;
use agent_client_protocol::schema::v1::{Plan, ToolCallUpdate, ToolCallUpdateFields};
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResponsePart {
    Text {
        id: String,
        text: String,
    },
    Plan {
        id: String,
        plan: Plan,
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
                ResponsePart::Tool { .. } | ResponsePart::Plan { .. } => None,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

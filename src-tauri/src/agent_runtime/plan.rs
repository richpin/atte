use crate::thread::{PermissionPlanReview, PlanContent};
use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionKind, PlanUpdate, PlanUpdateContent, ToolCallUpdateFields,
    ToolKind,
};

/// Normalize Codex's plan-review convention without relying on display labels.
pub(super) fn plan_review(
    tool_id: &str,
    fields: &ToolCallUpdateFields,
    options: &[PermissionOption],
) -> Option<PermissionPlanReview> {
    // Codex uses the completed plan item's ID in both planId and plan-review:<ID>.
    // https://github.com/agentclientprotocol/codex-acp/blob/main/src/tool-calls/reporters/PlanReviewReporter.ts
    let plan_id = tool_id
        .strip_prefix("plan-review:")
        .filter(|id| !id.is_empty())?;
    if fields.kind != Some(ToolKind::SwitchMode)
        || !options.iter().any(|option| {
            option.option_id.0.as_ref() == "implement_plan"
                && option.kind == PermissionOptionKind::AllowOnce
        })
        || !options.iter().any(|option| {
            option.option_id.0.as_ref() == "revise_plan"
                && option.kind == PermissionOptionKind::RejectOnce
        })
        || fields
            .content
            .as_ref()
            .is_some_and(|content| !content.is_empty())
        || fields
            .locations
            .as_ref()
            .is_some_and(|locations| !locations.is_empty())
    {
        return None;
    }
    let input = fields.raw_input.as_ref()?.as_object()?;
    // Preserve all details when the request also includes another operation's input.
    if input.len() != 1 {
        return None;
    }
    let content = input
        .get("plan")?
        .as_str()
        .filter(|text| !text.trim().is_empty())?;
    Some(PermissionPlanReview {
        plan_id: plan_id.to_owned(),
        content: content.to_owned(),
    })
}

/// Keep the draft wire types at the ACP boundary.
pub(super) fn plan_content(update: PlanUpdate) -> Option<(String, PlanContent)> {
    match update.plan {
        PlanUpdateContent::Items(plan) => Some((
            plan.plan_id.to_string(),
            PlanContent::Items {
                entries: plan.entries,
            },
        )),
        PlanUpdateContent::Markdown(plan) => Some((
            plan.plan_id.to_string(),
            PlanContent::Markdown {
                content: plan.content,
            },
        )),
        PlanUpdateContent::File(plan) => Some((
            plan.plan_id.to_string(),
            PlanContent::File { uri: plan.uri },
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::RequestPermissionRequest;
    use serde_json::json;

    #[test]
    fn recognizes_plan_review_without_using_display_labels() {
        let request: RequestPermissionRequest = serde_json::from_value(json!({
            "sessionId": "session",
            "toolCall": {
                "toolCallId": "plan-review:document",
                "title": "계획을 구현할까요?",
                "kind": "switch_mode",
                "rawInput": {"plan": "# Greeting CLI\n- Add the command"}
            },
            "options": [
                {"optionId": "implement_plan", "name": "구현", "kind": "allow_once"},
                {"optionId": "revise_plan", "name": "수정", "kind": "reject_once"}
            ]
        }))
        .unwrap();
        assert_eq!(
            plan_review(
                &request.tool_call.tool_call_id.to_string(),
                &request.tool_call.fields,
                &request.options,
            ),
            Some(PermissionPlanReview {
                plan_id: "document".into(),
                content: "# Greeting CLI\n- Add the command".into(),
            })
        );
    }

    #[test]
    fn keeps_unknown_or_additional_operations_as_ordinary_permissions() {
        let original = json!({
            "sessionId": "session",
            "toolCall": {
                "toolCallId": "plan-review:document",
                "kind": "switch_mode",
                "rawInput": {"plan": "# Plan"}
            },
            "options": [
                {"optionId": "implement_plan", "name": "Implement", "kind": "allow_once"},
                {"optionId": "revise_plan", "name": "Revise", "kind": "reject_once"}
            ]
        });
        for (pointer, value) in [
            ("/toolCall/toolCallId", json!("mode-change")),
            ("/toolCall/toolCallId", json!("plan-review:")),
            ("/toolCall/kind", json!("execute")),
            (
                "/toolCall/rawInput",
                json!({"plan": "# Plan", "command": "rm file.txt"}),
            ),
            ("/toolCall/rawInput", json!({"plan": "  "})),
            ("/toolCall/rawInput", json!({"plan": 42})),
            ("/options/0/kind", json!("allow_always")),
            ("/options/1/optionId", json!("deny")),
        ] {
            let mut wire = original.clone();
            *wire.pointer_mut(pointer).unwrap() = value;
            let request: RequestPermissionRequest = serde_json::from_value(wire).unwrap();
            assert_eq!(
                plan_review(
                    &request.tool_call.tool_call_id.to_string(),
                    &request.tool_call.fields,
                    &request.options,
                ),
                None,
                "{pointer}"
            );
        }
        for (field, value) in [
            (
                "content",
                json!([{"type": "content", "content": {"type": "text", "text": "Allow external access"}}]),
            ),
            ("locations", json!([{"path": "/sensitive.txt"}])),
        ] {
            let mut wire = original.clone();
            wire["toolCall"][field] = value;
            let request: RequestPermissionRequest = serde_json::from_value(wire).unwrap();
            assert_eq!(
                plan_review(
                    &request.tool_call.tool_call_id.to_string(),
                    &request.tool_call.fields,
                    &request.options,
                ),
                None,
                "{field}"
            );
        }
    }
}

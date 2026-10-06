use crate::thread::PlanContent;
use agent_client_protocol::schema::v1::{PlanUpdate, PlanUpdateContent};

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

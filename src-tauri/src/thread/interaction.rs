//! Pending user interactions and authoritative form validation.
use super::{PermissionRequest, ThreadError};
use agent_client_protocol::schema::v1::{
    ElicitationPropertySchema, ElicitationSchema, MultiSelectItems,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::Arc;
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingInteraction {
    Permission(PermissionRequest),
    Elicitation(FormRequest),
}

impl PendingInteraction {
    pub fn id(&self) -> Uuid {
        match self {
            Self::Permission(request) => request.id,
            Self::Elicitation(request) => request.id,
        }
    }

    pub fn permission(&self) -> Option<&PermissionRequest> {
        match self {
            Self::Permission(request) => Some(request),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormRequest {
    pub id: Uuid,
    pub message: String,
    pub tool_call_id: Option<String>,
    pub schema: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum ElicitationAnswer {
    Accept { values: Map<String, Value> },
    Decline,
    Cancel,
}

pub(super) enum PendingReply {
    Permission {
        sender: oneshot::Sender<String>,
        owner: Uuid,
    },
    Elicitation {
        sender: oneshot::Sender<ElicitationAnswer>,
        validator: Arc<jsonschema::Validator>,
        owner: Option<Uuid>,
    },
}

impl PendingReply {
    pub fn owner(&self) -> Option<Uuid> {
        match self {
            Self::Permission { owner, .. } => Some(*owner),
            Self::Elicitation { owner, .. } => *owner,
        }
    }
}

pub(crate) fn prepare_form(
    schema: &ElicitationSchema,
) -> Result<(Value, Arc<jsonschema::Validator>), ThreadError> {
    if schema.properties.values().any(|field| match field {
        ElicitationPropertySchema::String(_)
        | ElicitationPropertySchema::Number(_)
        | ElicitationPropertySchema::Integer(_)
        | ElicitationPropertySchema::Boolean(_) => false,
        ElicitationPropertySchema::Array(array) => !matches!(
            array.items,
            MultiSelectItems::Titled(_) | MultiSelectItems::String(_)
        ),
        _ => true,
    }) {
        return Err(ThreadError::InvalidMessage(
            "지원하지 않는 질문 필드입니다.".into(),
        ));
    }
    let mut value = serde_json::to_value(schema)
        .map_err(|_| ThreadError::InvalidMessage("질문 형식이 올바르지 않습니다.".into()))?;
    if schema.required.as_ref().is_some_and(|names| {
        names
            .iter()
            .any(|name| !schema.properties.contains_key(name))
    }) {
        return Err(ThreadError::InvalidMessage(
            "필수 질문 필드를 찾을 수 없습니다.".into(),
        ));
    }
    // ACP forms contain only their declared, flat properties.
    value["additionalProperties"] = Value::Bool(false);
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&value)
        .map_err(|_| ThreadError::InvalidMessage("질문 스키마가 올바르지 않습니다.".into()))?;
    Ok((value, Arc::new(validator)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_all_supported_fields_without_coercion() {
        let schema = serde_json::from_value(json!({"type":"object","properties":{
            "text":{"type":"string","minLength":2,"maxLength":4,"pattern":"^[a-z]+$"},
            "email":{"type":"string","format":"email"},
            "date":{"type":"string","format":"date"},
            "integer":{"type":"integer","minimum":1,"maximum":3},
            "number":{"type":"number","minimum":0.5},
            "boolean":{"type":"boolean"},
            "single":{"type":"string","oneOf":[{"const":"a","title":"A"}]},
            "multi":{"type":"array","items":{"type":"string","enum":["a","b"]},"minItems":1,"maxItems":2}},
            "required":["boolean","integer","single","multi"]})).unwrap();
        let (_, validator) = prepare_form(&schema).unwrap();
        let valid = json!({"text":"abc","email":"a@example.com","date":"2026-10-20","integer":2,"number":0.75,"boolean":false,"single":"a","multi":["b"]});
        assert!(validator.is_valid(&valid));
        for (field, invalid) in [
            ("text", json!("123")),
            ("email", json!("bad")),
            ("date", json!("2026-99-99")),
            ("integer", json!(1.5)),
            ("integer", json!("2")),
            ("integer", json!(4)),
            ("number", json!(0.1)),
            ("boolean", Value::Null),
            ("single", json!("other")),
            ("multi", json!([])),
            ("multi", json!(["other"])),
        ] {
            let mut value = valid.clone();
            value[field] = invalid;
            assert!(!validator.is_valid(&value), "{field}");
        }
        let mut extra = valid;
        extra["extra"] = json!(true);
        assert!(!validator.is_valid(&extra));
    }

    #[test]
    fn rejects_unknown_controls_and_invalid_schemas() {
        for schema in [
            json!({"type":"object","properties":{"nested":{"type":"object"}}}),
            json!({"type":"object","properties":{"array":{"type":"array","items":{"type":"integer"}}}}),
            json!({"type":"object","properties":{},"required":["missing"]}),
            json!({"type":"object","properties":{"text":{"type":"string","pattern":"["}}}),
        ] {
            assert!(prepare_form(&serde_json::from_value(schema).unwrap()).is_err());
        }
    }
}

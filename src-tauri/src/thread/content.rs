//! Transcript content stays in Rust; subscriptions carry only display metadata.
use agent_client_protocol::schema::v1::{
    ContentBlock, EmbeddedResourceResource, ToolCallContent, ToolCallUpdateFields,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{ser::SerializeMap, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq)]
pub struct ResponseContent(pub Arc<ContentBlock>);

/// A content-addressed reference is stable across snapshots and replay, but scoped
/// to the owning thread when read. Replacing a tool result cannot expose old bytes.
pub fn content_id(source: &ContentBlock) -> String {
    struct Hasher(Sha256);
    impl std::io::Write for Hasher {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut hasher = Hasher(Sha256::new());
    // ContentBlock contains JSON-compatible protocol values; the writer is infallible.
    if serde_json::to_writer(&mut hasher, source).is_err() {
        hasher.0.update(b"unsupported-content");
    }
    format!("{:x}", hasher.0.finalize())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentView<'a> {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uri: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<i64>,
    has_data: bool,
}

fn resource_name(uri: &str) -> &str {
    uri.rsplit('/').find(|part| !part.is_empty()).unwrap_or(uri)
}

impl<'a> ContentView<'a> {
    fn new(source: &'a ContentBlock) -> Self {
        let mut view = Self {
            id: content_id(source),
            kind: "unsupported",
            name: "",
            text: None,
            uri: None,
            mime_type: None,
            description: None,
            size: None,
            has_data: false,
        };
        match source {
            ContentBlock::Text(text) => {
                view.kind = "text";
                view.text = Some(&text.text);
            }
            ContentBlock::Image(image) => {
                view.kind = "image";
                view.mime_type = Some(&image.mime_type);
                view.uri = image.uri.as_deref();
                view.has_data = true;
            }
            ContentBlock::Audio(audio) => {
                view.kind = "audio";
                view.mime_type = Some(&audio.mime_type);
                view.has_data = true;
            }
            ContentBlock::ResourceLink(link) => {
                view.kind = "resource_link";
                view.name = link.title.as_deref().unwrap_or(&link.name);
                view.uri = Some(&link.uri);
                view.mime_type = link.mime_type.as_deref();
                view.description = link.description.as_deref();
                view.size = link.size;
            }
            ContentBlock::Resource(resource) => {
                view.kind = "resource";
                view.has_data = true;
                match &resource.resource {
                    EmbeddedResourceResource::TextResourceContents(text) => {
                        view.uri = Some(&text.uri);
                        view.mime_type = text.mime_type.as_deref();
                        view.text = Some(&text.text);
                    }
                    EmbeddedResourceResource::BlobResourceContents(blob) => {
                        view.uri = Some(&blob.uri);
                        view.mime_type = blob.mime_type.as_deref();
                    }
                    _ => {
                        view.has_data = false;
                    }
                }
                view.name = view.uri.map(resource_name).unwrap_or("");
            }
            _ => {}
        }
        view
    }
}

impl Serialize for ResponseContent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ContentView::new(&self.0).serialize(serializer)
    }
}

impl ResponseContent {
    pub fn new(source: ContentBlock) -> Self {
        Self(Arc::new(source))
    }

    pub fn bytes(&self) -> Result<Vec<u8>, String> {
        let encoded = match self.0.as_ref() {
            ContentBlock::Image(image) => &image.data,
            ContentBlock::Audio(audio) => &audio.data,
            ContentBlock::Resource(resource) => match &resource.resource {
                EmbeddedResourceResource::TextResourceContents(text) => {
                    return Ok(text.text.as_bytes().to_vec())
                }
                EmbeddedResourceResource::BlobResourceContents(blob) => &blob.blob,
                _ => return Err("unsupportedContent".into()),
            },
            _ => return Err("unsupportedContent".into()),
        };
        STANDARD
            .decode(encoded)
            .map_err(|_| "invalidContent".into())
    }

    pub fn name(&self) -> String {
        let view = ContentView::new(&self.0);
        if !view.name.is_empty() {
            return view.name.to_owned();
        }
        let extension = match view.mime_type.unwrap_or("") {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/svg+xml" => "svg",
            "audio/wav" => "wav",
            "audio/mpeg" => "mp3",
            "audio/ogg" => "ogg",
            _ => "bin",
        };
        format!("{}.{}", view.kind, extension)
    }
}

struct ToolContents<'a>(Vec<&'a ToolCallContent>);
impl Serialize for ToolContents<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for item in &self.0 {
            if let ToolCallContent::Content(content) = item {
                #[derive(Serialize)]
                struct View<'a> {
                    r#type: &'static str,
                    content: ContentView<'a>,
                }
                sequence.serialize_element(&View {
                    r#type: "content",
                    content: ContentView::new(&content.content),
                })?;
            } else {
                sequence.serialize_element(item)?;
            }
        }
        sequence.end()
    }
}

pub fn serialize_tool<S: Serializer>(
    tool: &ToolCallUpdateFields,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut map = serializer.serialize_map(None)?;
    if let Some(value) = &tool.title {
        map.serialize_entry("title", value)?;
    }
    if let Some(value) = &tool.kind {
        map.serialize_entry("kind", value)?;
    }
    if let Some(value) = &tool.status {
        map.serialize_entry("status", value)?;
    }
    if let Some(value) = &tool.content {
        map.serialize_entry("content", &ToolContents(value.iter().collect()))?;
    }
    if let Some(value) = &tool.locations {
        map.serialize_entry("locations", value)?;
    }
    if let Some(value) = &tool.raw_input {
        map.serialize_entry("rawInput", value)?;
    }
    if let Some(value) = &tool.raw_output {
        map.serialize_entry("rawOutput", value)?;
    }
    map.end()
}

pub(crate) fn permission_details(content: &[ToolCallContent]) -> Option<String> {
    let visible = content
        .iter()
        .filter(|item| !matches!(item, ToolCallContent::Terminal(_)))
        .collect::<Vec<_>>();
    if visible.is_empty() {
        return None;
    }
    serde_json::to_string_pretty(&ToolContents(visible)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn subscriptions_reference_payloads_without_serializing_their_bytes() {
        for source in [
            json!({"type":"image","mimeType":"image/png","data":"aW1hZ2U="}),
            json!({"type":"audio","mimeType":"audio/wav","data":"aW1hZ2U="}),
            json!({"type":"resource","resource":{"uri":"file:///result.bin","blob":"aW1hZ2U="}}),
        ] {
            let content = ResponseContent::new(serde_json::from_value(source).unwrap());
            let value = serde_json::to_value(&content).unwrap();
            assert!(value.get("data").is_none());
            assert!(value.get("blob").is_none());
            assert!(value["hasData"].as_bool().unwrap());
            assert_eq!(content.bytes().unwrap(), b"image");
            assert_eq!(value["id"], content_id(&content.0));
        }
    }

    #[test]
    fn corrupt_media_remains_visible_but_cannot_be_read() {
        let content = ResponseContent::new(
            serde_json::from_value(
                json!({"type":"image","mimeType":"image/png","data":"not base64!"}),
            )
            .unwrap(),
        );
        assert_eq!(serde_json::to_value(&content).unwrap()["type"], "image");
        assert_eq!(content.bytes().unwrap_err(), "invalidContent");
    }

    #[test]
    fn permission_details_do_not_duplicate_media_bytes_into_pending_interactions() {
        let items: Vec<ToolCallContent> = serde_json::from_value(json!([
            {"type":"content","content":{"type":"text","text":"Inspect image"}},
            {"type":"content","content":{"type":"image","mimeType":"image/png","data":"aW1hZ2U="}},
            {"type":"terminal","terminalId":"terminal"}
        ]))
        .unwrap();
        let details = permission_details(&items).unwrap();
        assert!(details.contains("Inspect image"));
        assert!(details.contains("image/png"));
        assert!(!details.contains("aW1hZ2U="));
        assert!(!details.contains("terminalId"));
    }
}

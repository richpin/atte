use super::*;
use crate::mcp::import::{Format, Selection};
fn preview(service: &Mcp, text: &str, format: Format) -> Value {
    serde_json::to_value(service.preview_import(text, format, "Fixture", "/fixture/config"))
        .unwrap()
}
fn selection(candidate: &Value, name: &str, overwrite: bool) -> Selection {
    serde_json::from_value(json!({"id":candidate["id"],"name":name,"overwrite":overwrite})).unwrap()
}
#[test]
fn formats_import_disabled_with_secrets_in_credentials_and_preserve_sources() {
    let cases = [
        (Format::Json, "claude.json", r#"{"mcpServers":{"local":{"command":"fixture","args":["a b"],"env":{"API_KEY":"fixture-secret","REF":"${EXISTING}"}}}}"#),
        (Format::Json, "desktop.json", r#"{"mcpServers":{"local":{"command":"fixture","env":{"API_KEY":"fixture-secret"}}},"preferences":{"theme":"dark"}}"#),
        (Format::Jsonc, "cursor.json", "{ // comment\n\"mcpServers\":{\"local\":{\"url\":\"https://example.com/mcp\",\"headers\":{\"Authorization\":\"fixture-secret\"},},},}"),
        (Format::Codex, "config.toml", "[mcp_servers.local]\ncommand = 'fixture'\nenv_vars = ['EXISTING']\n[mcp_servers.local.env]\nAPI_KEY = 'fixture-secret'"),
        (Format::Zed, "settings.json", "{ // comment\n\"context_servers\": {\"local\":{\"command\":\"fixture\",\"env\":{\"API_KEY\":\"fixture-secret\"}}},\"theme\":\"Dark\"}"),
    ];
    for (format, filename, text) in cases {
        let root = tempfile::tempdir().unwrap();
        let credentials = Arc::new(MemoryCredentials::default());
        let service = service(root.path(), credentials.clone());
        std::fs::create_dir(root.path().join("source")).unwrap();
        let source = root.path().join("source").join(filename);
        std::fs::write(&source, text).unwrap();
        let discovered = service.discover_at(vec![("Fixture", source.clone(), format)]);
        let reviewed = serde_json::to_value(discovered).unwrap();
        assert!(!reviewed.to_string().contains("fixture-secret"));
        assert!(service.snapshot(&Target::Global).servers.is_empty());
        assert!(credentials.0.lock().unwrap().is_empty());
        let results = service.import_selected(
            &Target::Global,
            vec![selection(&reviewed[0]["candidates"][0], "imported", false)],
        );
        assert!(serde_json::to_value(results).unwrap()[0]["error"].is_null());
        assert!(!service.snapshot(&Target::Global).servers["imported"].enabled);
        assert!(!std::fs::read_to_string(root.path().join("settings.json"))
            .unwrap()
            .contains("fixture-secret"));
        assert!(credentials
            .0
            .lock()
            .unwrap()
            .values()
            .any(|value| value == "fixture-secret"));
        assert_eq!(std::fs::read_to_string(source).unwrap(), text);
    }
}
#[test]
fn malformed_missing_and_unsupported_sources_do_not_block_other_candidates() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    let damaged = root.path().join("bad.json");
    std::fs::write(&damaged, "{ secret-content").unwrap();
    let good = root.path().join("good.json");
    std::fs::write(&good, r#"{"mcpServers":{"good":{"command":"fixture"},"sse":{"type":"sse","url":"https://example.com"},"policy":{"command":"fixture","tools":["one"]},"var":{"command":"fixture","env":{"KEY":"Bearer ${TOKEN}"}}}}"#).unwrap();
    let result = serde_json::to_value(service.discover_at(vec![
        ("Bad", damaged, Format::Json),
        ("Missing", root.path().join("missing"), Format::Codex),
        ("Good", good, Format::Json),
    ]))
    .unwrap();
    assert_eq!(result[0]["status"], "error");
    assert!(!result.to_string().contains("secret-content"));
    assert_eq!(result[1]["status"], "missing");
    let candidates = result[2]["candidates"].as_array().unwrap();
    assert_eq!(
        candidates
            .iter()
            .filter(|candidate| candidate["id"].is_string())
            .count(),
        1
    );
    assert_eq!(
        candidates
            .iter()
            .filter(|candidate| candidate["reason"].is_string())
            .count(),
        3
    );
    assert_eq!(
        std::fs::read(root.path().join("bad.json")).unwrap(),
        b"{ secret-content"
    );
}
#[test]
fn conflicts_require_explicit_overwrite_or_rename_and_partial_success_is_reported() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    service
        .save(&Target::Global, "taken", http(), BTreeMap::new(), true)
        .unwrap();
    let reviewed = preview(
        &service,
        r#"{"mcpServers":{"one":{"command":"fixture"},"two":{"command":"fixture"}}}"#,
        Format::Json,
    );
    let result = service.import_selected(
        &Target::Global,
        vec![
            selection(&reviewed["candidates"][0], "taken", false),
            selection(&reviewed["candidates"][1], "renamed", false),
        ],
    );
    let result = serde_json::to_value(result).unwrap();
    assert!(result[0]["error"].is_string());
    assert!(result[1]["error"].is_null());
    assert!(service.snapshot(&Target::Global).servers["taken"].enabled);
    let project = Target::Project {
        folder: root.path().into(),
    };
    let result = service.import_selected(
        &project,
        vec![selection(&reviewed["candidates"][0], "taken", false)],
    );
    assert!(serde_json::to_value(result).unwrap()[0]["error"].is_null());
    let reviewed = preview(
        &service,
        r#"{"mcpServers":{"one":{"command":"fixture"}}}"#,
        Format::Json,
    );
    let result = service.import_selected(
        &Target::Global,
        vec![selection(&reviewed["candidates"][0], "taken", true)],
    );
    assert!(serde_json::to_value(result).unwrap()[0]["error"].is_null());
    assert!(!service.snapshot(&Target::Global).servers["taken"].enabled);
}
#[test]
fn invalid_documents_and_unsupported_options_never_expose_source_values() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    for (format, text) in [
        (Format::Codex, "[mcp_servers.x]\nurl = 'secret'\nurl = 2"),
        (Format::Json, "{\"mcpServers\":[]}"),
        (
            Format::Jsonc,
            "{\"mcpServers\": {\"x\":{\"command\":\"x\" \"args\":[]}}}",
        ),
        (
            Format::Json,
            r#"{"mcpServers":{"x":{"command":"fixture","oauth":{"token":"hidden-token"}}}}"#,
        ),
    ] {
        let result = preview(&service, text, format);
        assert!(!result.to_string().contains("hidden-token"));
        assert!(result["error"].is_string() || result["candidates"][0]["reason"].is_string());
    }
}
#[test]
fn closing_review_discards_pending_secrets_and_rejects_old_ids() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    let reviewed = preview(
        &service,
        r#"{"mcpServers":{"x":{"command":"fixture","env":{"KEY":"hidden-token"}}}}"#,
        Format::Json,
    );
    service.clear_imports();
    let result = service.import_selected(
        &Target::Global,
        vec![selection(&reviewed["candidates"][0], "x", false)],
    );
    assert!(serde_json::to_value(result).unwrap()[0]["error"].is_string());
    assert!(service.snapshot(&Target::Global).servers.is_empty());
}

#[test]
fn credential_failure_keeps_import_pending_and_leaves_destination_and_source_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(LockedCredentials));
    let source = root.path().join("source.json");
    let text = r#"{"mcpServers":{"private":{"url":"https://example.com/mcp","headers":{"Authorization":"hidden-token"}}}}"#;
    std::fs::write(&source, text).unwrap();
    let before = std::fs::read(root.path().join("settings.json")).unwrap();
    let reviewed =
        serde_json::to_value(service.discover_at(vec![("Fixture", source.clone(), Format::Json)]))
            .unwrap();
    let result = service.import_selected(
        &Target::Global,
        vec![selection(&reviewed[0]["candidates"][0], "private", false)],
    );
    let result = serde_json::to_value(result).unwrap();
    assert!(result[0]["error"].is_string());
    assert!(!result.to_string().contains("hidden-token"));
    assert_eq!(
        std::fs::read(root.path().join("settings.json")).unwrap(),
        before
    );
    assert_eq!(std::fs::read_to_string(source).unwrap(), text);
}

#[test]
fn importing_back_into_the_source_file_is_rejected_without_mutation() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    let before = std::fs::read(root.path().join("settings.json")).unwrap();
    let reviewed = serde_json::to_value(service.preview_import(
        r#"{"mcpServers":{"x":{"command":"fixture"}}}"#,
        Format::Json,
        "Fixture",
        &root.path().join("settings.json").to_string_lossy(),
    ))
    .unwrap();
    let result = service.import_selected(
        &Target::Global,
        vec![selection(&reviewed["candidates"][0], "x", false)],
    );
    assert!(serde_json::to_value(result).unwrap()[0]["error"].is_string());
    assert_eq!(
        std::fs::read(root.path().join("settings.json")).unwrap(),
        before
    );
}

#[test]
fn credential_arguments_are_rejected_without_returning_or_saving_their_values() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path(), Arc::new(MemoryCredentials::default()));
    for args in [
        json!(["--api-key", "hidden-token"]),
        json!(["--key=opaque-value"]),
        json!(["--access-key", "opaque-value"]),
        json!(["--pass", "opaque-value"]),
        json!([
            "mcp-remote",
            "--header",
            "Authorization: Bearer hidden-token"
        ]),
        json!(["-H", "X-Api-Key: hidden-token"]),
        json!(["TOKEN=hidden-token"]),
        json!(["https://example.com/mcp?key=hidden-token"]),
    ] {
        let result = preview(
            &service,
            &json!({"mcpServers":{"private":{"command":"fixture","args":args}}}).to_string(),
            Format::Json,
        );
        assert!(result["candidates"][0]["id"].is_null());
        assert!(result["candidates"][0]["reason"].is_string());
        assert!(!result.to_string().contains("hidden-token"));
    }
    assert!(service.snapshot(&Target::Global).servers.is_empty());
}

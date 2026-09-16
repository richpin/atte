Treat the WebView and Rust Core as a trust boundary.
Keep OS access, sensitive business logic, global application state, and database connections in the Rust Core where appropriate.
Keep the frontend focused on UI and presentation rather than exposing broad system primitives to JavaScript.
Design Tauri commands as narrow application-level APIs.
Use async commands for heavy, blocking, or long-running work.
Prefer owned parameters such as String in async commands.
Model fallible commands with Result.
Use serializable, structured error types when errors need to be handled programmatically by the frontend.
Manage shared backend state through Tauri state and use appropriate synchronization primitives.
Follow least privilege for capabilities, permissions, and scopes.
Grant permissions only to the windows, webviews, platforms, commands, paths, URLs, and arguments that actually require them.
Keep filesystem scopes narrow.
Keep shell command and argument scopes narrow; do not allow arbitrary shell execution unless absolutely necessary.
Preserve Tauri's default-deny behavior for dangerous plugin APIs.
Do not grant Tauri APIs to remote web content unless there is a specific reviewed requirement.
Configure a restrictive CSP and avoid remote scripts or untrusted remote assets where possible.
Validate security-sensitive input again in Rust; never rely solely on frontend validation.
Use events for simple notifications and Channels for ordered or high-volume streaming data.
Separate capabilities by window or webview when different windows require different privilege levels.
Use Tauri-generated schemas for capability configuration.
Follow Tauri's recommended Vite configuration, including a fixed dev-server port and excluding src-tauri from frontend file watching.

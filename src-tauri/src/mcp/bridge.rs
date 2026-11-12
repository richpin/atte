//! Headless stdio adapter. This entry point runs before Tauri is initialized.
use futures_util::{stream::FuturesUnordered, StreamExt};
use rmcp::{
    service::RoleClient,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
        Transport,
    },
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

pub async fn run(url: String) -> Result<(), &'static str> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid relay URL")?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.path() != "/mcp"
        || parsed.query().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Invalid relay URL");
    }
    let token = std::env::var("ATTE_MCP_RELAY_TOKEN").map_err(|_| "Missing relay credential")?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot start bridge")?;
    // A held-open authenticated lease lets Atte stop an idle bridge without
    // closing another session or depending on the agent to close its stdin.
    let lease = client
        .get(parsed.join("/lease").map_err(|_| "Invalid relay URL")?)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| "MCP relay disconnected")?
        .error_for_status()
        .map_err(|_| "MCP relay disconnected")?;
    let lifetime = async move {
        let mut stream = lease.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if chunk.is_err() {
                break;
            }
        }
    };
    tokio::pin!(lifetime);
    let mut transport = StreamableHttpClientTransport::with_client(
        client,
        StreamableHttpClientTransportConfig::with_uri(url).auth_header(token),
    );
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    let mut pending = FuturesUnordered::new();
    let result = loop {
        tokio::select! {
            _ = &mut lifetime => break Err("MCP relay disconnected"),
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        let message: rmcp::service::TxJsonRpcMessage<RoleClient> = match serde_json::from_str(&line) {
                            Ok(message) => message,
                            Err(_) => break Err("Invalid MCP message"),
                        };
                        pending.push(transport.send(message));
                    }
                    Ok(None) => break Ok(()),
                    Err(_) => break Err("Cannot read MCP input"),
                }
            }
            result = pending.next(), if !pending.is_empty() => {
                if result.is_some_and(|result| result.is_err()) { break Err("MCP relay disconnected"); }
            }
            message = transport.receive() => {
                let Some(message) = message else { break Ok(()); };
                let mut bytes = serde_json::to_vec(&message).map_err(|_| "Invalid MCP message")?;
                bytes.push(b'\n');
                let write = async {
                    output.write_all(&bytes).await?;
                    output.flush().await
                };
                tokio::select! {
                    _ = &mut lifetime => break Err("MCP relay disconnected"),
                    result = write => if result.is_err() { break Err("Cannot write MCP output"); },
                }
            }
        }
    };
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), transport.close()).await;
    result
}

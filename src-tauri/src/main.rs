// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() == Some("--mcp-stdio-bridge") {
        let Some(url) = arguments.next() else {
            std::process::exit(2);
        };
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(_) => std::process::exit(1),
        };
        if runtime.block_on(atte_lib::mcp::bridge::run(url)).is_err() {
            std::process::exit(1);
        }
        return;
    }
    atte_lib::run()
}

#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

cargo +nightly fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features --locked

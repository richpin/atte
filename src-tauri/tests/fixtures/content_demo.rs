//! Playable, deterministic content for manual desktop verification.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{env, fs};

pub fn tone() -> Vec<u8> {
    let sample_rate = 16_000_u32;
    let data_size = sample_rate * 2;
    let mut wav = Vec::with_capacity(44 + data_size as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1_u16.to_le_bytes()); // mono
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for i in 0..sample_rate {
        let time = i as f32 / sample_rate as f32;
        let fade = (time / 0.02).min((1.0 - time) / 0.02).min(1.0);
        let sample = ((time * 440.0 * std::f32::consts::TAU).sin() * fade * 4_000.0) as i16;
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

pub fn updates() -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let path = env::current_dir()?.join("preview.html");
    fs::write(&path, "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>ACP content check</title><h1>ACP local resource link works</h1><p>This file belongs to the isolated content test workspace.</p></html>")?;
    let uri = tauri::Url::from_file_path(&path).map_err(|()| "invalid fixture path")?;
    let audio = json!({"type":"audio","mimeType":"audio/wav","data":STANDARD.encode(tone())});
    let web = json!({"type":"resource_link","name":"Web link test","uri":"https://example.com","mimeType":"text/html","description":"링크를 누르면 Web 탭에 Example Domain이 표시됩니다."});
    let file = json!({"type":"resource_link","name":"Local file test","uri":uri.as_str(),"mimeType":"text/html","description":"링크를 누르면 Files 탭에 preview.html 원문이 표시됩니다."});
    let resource = json!({"type":"resource","resource":{"uri":"test:///report.txt","mimeType":"text/plain","text":"ACP embedded text resource\n원문 펼치기, 내용 복사, 다른 이름으로 저장을 확인하세요."}});
    Ok(vec![
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ACP 콘텐츠 테스트입니다. 아래 오디오는 1초짜리 440Hz 알림음이며 재생 버튼을 눌러야 들립니다. 웹·로컬 파일 링크도 눌러보세요."}}),
        json!({"sessionUpdate":"agent_message_chunk","content":audio}),
        json!({"sessionUpdate":"agent_message_chunk","content":web}),
        json!({"sessionUpdate":"agent_message_chunk","content":file}),
        json!({"sessionUpdate":"agent_message_chunk","content":resource}),
        json!({"sessionUpdate":"tool_call","toolCallId":"content-demo-tool","title":"ACP tool content test","status":"completed","rawInput":{"test":"audio and resource links"},"content":[
            {"type":"content","content":{"type":"text","text":"도구 결과 시작"}},
            {"type":"content","content":audio},
            {"type":"content","content":web},
            {"type":"content","content":file},
            {"type":"content","content":{"type":"text","text":"도구 결과 끝"}}
        ]}),
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"다른 대화로 이동하면 오디오가 멈춰야 합니다. 앱을 닫고 같은 테스트 명령으로 다시 열면 이 순서와 콘텐츠가 기록에서 복원됩니다."}}),
    ])
}

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use async_ssh2_russh::{russh::Disconnect, AsyncChannel, NoCheckHandler, ReadStream};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_store::StoreExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};
use url::Url;

// ==================== 数据模型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Asset {
    id: String,
    title: String,
    platform_type: String,
    address: String,
}

// ==================== JumpServer API 工具 ====================

fn generate_signature(secret: &str, string_to_sign: &str) -> String {
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(string_to_sign.as_bytes());
    let result = mac.finalize();
    general_purpose::STANDARD.encode(result.into_bytes())
}

fn get_auth_header(
    key_id: &str,
    secret: &str,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
) -> String {
    let signature_headers = ["(request-target)", "accept", "date"];
    let request_target = format!("{} {}", method.to_lowercase(), path);
    let mut string_to_sign = format!("(request-target): {}\n", request_target);
    for h in &signature_headers[1..] {
        let value = headers.get(*h).cloned().unwrap_or_default();
        string_to_sign.push_str(&format!("{}: {}\n", h, value));
    }
    string_to_sign = string_to_sign.trim_end().to_string();
    let signature = generate_signature(secret, &string_to_sign);
    let headers_str = signature_headers.join(" ");
    format!(
        "Signature keyId=\"{}\",algorithm=\"hmac-sha256\",headers=\"{}\",signature=\"{}\"",
        key_id, headers_str, signature
    )
}

async fn jms_request(
    jms_url: &str,
    key_id: &str,
    secret: &str,
    method: &str,
    api_path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let base_url = jms_url.trim_end_matches('/');
    let url = format!("{}{}", base_url, api_path);

    let parsed = Url::parse(&url).map_err(|e| format!("URL parse error: {}", e))?;
    let request_path = format!("{}{}", parsed.path(), parsed.query().map(|q| format!("?{}", q)).unwrap_or_default());

    // 与原版 Electron 保持一致的 GMT 日期格式
    let date_str = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let mut headers = HashMap::new();
    headers.insert("accept".to_string(), "application/json".to_string());
    headers.insert(
        "X-JMS-ORG".to_string(),
        "00000000-0000-0000-0000-000000000002".to_string(),
    );
    headers.insert("date".to_string(), date_str.clone());

    if body.is_some() {
        headers.insert("Content-Type".to_string(), "application/json".to_string());
    }

    let auth_header = get_auth_header(key_id, secret, method, &request_path, &headers);

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("reqwest build error: {}", e))?;

    let mut req = client.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), &url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    req = req.header("Authorization", auth_header);

    if let Some(b) = body {
        req = req.json(&b);
    }

    let res = req.send().await.map_err(|e| format!("request error: {}", e))?;
    let text = res.text().await.map_err(|e| format!("read body error: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("JSON parse error: {} | {}", e, &text[..text.len().min(200)]))
}

// ==================== SSH 连接管理 ====================

struct SshConnection {
    write_tx: mpsc::UnboundedSender<Vec<u8>>,
    resize_tx: mpsc::UnboundedSender<(u32, u32)>,
    // 保存 russh 会话句柄，断开时显式发送 disconnect，避免 socket 泄漏
    handle: async_ssh2_russh::russh::client::Handle<NoCheckHandler>,
}

#[derive(Default)]
struct AppState {
    connections: Mutex<HashMap<String, SshConnection>>,
}

async fn send_to_tab(app: &AppHandle, tab_id: &str, channel: &str, data: &str) {
    let _ = app.emit(
        channel,
        json!({ "tabId": tab_id, "data": data }),
    );
}

async fn disconnect_tab_ssh(state: &AppState, tab_id: &str) {
    let conn = {
        let mut conns = state.connections.lock().await;
        conns.remove(tab_id)
    };
    if let Some(conn) = conn {
        // 先关闭写入端，让 writer task 退出
        drop(conn.write_tx);
        drop(conn.resize_tx);
        // 显式断开 SSH 会话，避免 channel/handle 依赖 GC 回收导致 socket 泄漏
        if let Err(e) = conn
            .handle
            .disconnect(Disconnect::ByApplication, "client closed", "en")
            .await
        {
            log::warn!("[ssh] disconnect {} failed: {}", tab_id, e);
        }
    }
}

async fn spawn_ssh_reader(mut reader: ReadStream, app: AppHandle, tab_id: String) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let data = String::from_utf8_lossy(&buf[..n]).to_string();
                let _ = send_to_tab(&app, &tab_id, "terminal-data", &data).await;
            }
            Err(e) => {
                let _ = send_to_tab(&app, &tab_id, "terminal-data", &format!("\r\n\x1b[31m读取错误: {}\x1b[0m\r\n", e)).await;
                break;
            }
        }
    }
    let _ = send_to_tab(&app, &tab_id, "ssh-status", "disconnected").await;
}

async fn spawn_ssh_writer(
    channel: AsyncChannel,
    mut write_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    mut resize_rx: mpsc::UnboundedReceiver<(u32, u32)>,
    app: AppHandle,
    tab_id: String,
) {
    loop {
        tokio::select! {
            biased;
            msg = write_rx.recv() => {
                match msg {
                    Some(data) => {
                        let mut stdin = channel.stdin();
                        if stdin.write_all(&data).await.is_err() {
                            let _ = send_to_tab(&app, &tab_id, "ssh-status", "error").await;
                            break;
                        }
                    }
                    None => break,
                }
            }
            size = resize_rx.recv() => {
                match size {
                    Some((cols, rows)) => {
                        if channel.window_change(cols, rows, 0, 0).await.is_err() {
                            let _ = send_to_tab(&app, &tab_id, "ssh-status", "error").await;
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }
}

async fn connect_ssh(
    state: &AppState,
    app: AppHandle,
    tab_id: &str,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    // 先断开旧连接
    disconnect_tab_ssh(state, tab_id).await;

    let addr = format!("{}:{}", host, port);

    let config = Arc::new(async_ssh2_russh::russh::client::Config::default());
    let mut handle = async_ssh2_russh::russh::client::connect(config, addr, NoCheckHandler)
        .await
        .map_err(|e| format!("SSH connect error: {}", e))?;

    let auth = handle
        .authenticate_password(username, password)
        .await
        .map_err(|e| format!("SSH auth error: {}", e))?;
    if !auth.success() {
        return Err("SSH 认证失败".to_string());
    }

    let russh_channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("SSH channel error: {}", e))?;
    let channel = AsyncChannel::from(russh_channel);
    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("SSH pty error: {}", e))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("SSH shell error: {}", e))?;

    // 必须在 shell 之前获取 stdout，否则可能收不到数据
    let stdout = channel.stdout();
    let (write_tx, write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, resize_rx) = mpsc::unbounded_channel::<(u32, u32)>();

    let conn = SshConnection {
        write_tx,
        resize_tx,
        handle,
    };

    let mut conns = state.connections.lock().await;
    conns.insert(tab_id.to_string(), conn);
    drop(conns);

    // 启动读写任务
    tokio::spawn(spawn_ssh_reader(stdout, app.clone(), tab_id.to_string()));
    tokio::spawn(spawn_ssh_writer(channel, write_rx, resize_rx, app.clone(), tab_id.to_string()));

    let _ = send_to_tab(&app, tab_id, "ssh-status", "connected").await;
    Ok(())
}

// ==================== Tauri 命令 ====================

#[tauri::command]
async fn validate_credentials(
    jms_url: String,
    key_id: String,
    secret: String,
) -> Result<Value, String> {
    let user = jms_request(&jms_url, &key_id, &secret, "GET", "/api/v1/users/profile/", None).await?;
    if user.get("id").is_none() {
        return Ok(json!({ "success": false, "error": "获取用户信息失败，请确认连接信息是否正确" }));
    }
    Ok(json!({
        "success": true,
        "user": {
            "id": user.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "name": user.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "username": user.get("username").and_then(|v| v.as_str()).unwrap_or(""),
            "email": user.get("email").and_then(|v| v.as_str()).unwrap_or(""),
        }
    }))
}

#[tauri::command]
async fn get_assets(jms_url: String, key_id: String, secret: String) -> Result<Value, String> {
    let data = jms_request(
        &jms_url,
        &key_id,
        &secret,
        "GET",
        "/api/v1/perms/users/self/assets/tree/",
        None,
    )
    .await?;

    let items = data.as_array().ok_or("获取资产列表失败")?;
    let assets: Vec<Asset> = items
        .iter()
        .filter(|item| {
            item.get("meta")
                .and_then(|m| m.get("data"))
                .and_then(|d| d.get("platform_type"))
                .and_then(|p| p.as_str())
                == Some("linux")
        })
        .map(|item| Asset {
            id: item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            title: item
                .get("title")
                .or_else(|| item.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string(),
            platform_type: "linux".to_string(),
            address: item
                .get("meta")
                .and_then(|m| m.get("data"))
                .and_then(|d| d.get("address"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect();

    Ok(json!({ "success": true, "assets": assets }))
}

#[tauri::command]
async fn connect_to_asset(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    jms_url: String,
    key_id: String,
    secret: String,
    username: String,
    asset_id: String,
    tab_id: String,
    cols: u32,
    rows: u32,
) -> Result<Value, String> {
    // 1. 获取资产连接账号
    let account = match jms_request(
        &jms_url,
        &key_id,
        &secret,
        "GET",
        &format!("/api/v1/perms/users/self/assets/{}/", asset_id),
        None,
    )
    .await
    {
        Ok(data) => data
            .get("permed_accounts")
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or(&username)
            .to_string(),
        Err(_) => username.clone(),
    };

    // 2. 获取连接令牌
    let token = jms_request(
        &jms_url,
        &key_id,
        &secret,
        "POST",
        "/api/v1/authentication/connection-token/",
        Some(json!({
            "asset": asset_id,
            "protocol": "ssh",
            "connect_method": "ssh_guide",
            "account": account,
        })),
    )
    .await?;

    let connection_id = token
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("获取连接令牌失败")?;
    let password = token
        .get("value")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 3. 解析 SSH 主机信息
    let parsed = Url::parse(jms_url.trim_end_matches('/')).map_err(|e| e.to_string())?;
    let ssh_host = parsed.host_str().ok_or("无法解析主机名")?;
    let ssh_port = 2222u16;
    let ssh_user = format!("JMS-{}", connection_id);

    // 4. 建立 SSH 连接
    connect_ssh(
        &state,
        app,
        &tab_id,
        ssh_host,
        ssh_port,
        &ssh_user,
        &password,
        cols,
        rows,
    )
    .await?;

    Ok(json!({ "success": true, "message": format!("已连接到资产 {}", asset_id) }))
}

#[tauri::command]
async fn disconnect_ssh(state: State<'_, Arc<AppState>>, tab_id: String) -> Result<Value, String> {
    disconnect_tab_ssh(&state, &tab_id).await;
    Ok(json!({ "success": true }))
}

#[tauri::command]
async fn disconnect_all_ssh(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let conns = {
        let mut guard = state.connections.lock().await;
        std::mem::take(&mut *guard)
    };
    for (tab_id, conn) in conns {
        drop(conn.write_tx);
        drop(conn.resize_tx);
        if let Err(e) = conn
            .handle
            .disconnect(Disconnect::ByApplication, "client closed", "en")
            .await
        {
            log::warn!("[ssh] disconnect {} failed: {}", tab_id, e);
        }
    }
    Ok(json!({ "success": true }))
}

#[tauri::command]
async fn terminal_input(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    data: String,
) -> Result<(), String> {
    let conns = state.connections.lock().await;
    if let Some(conn) = conns.get(&tab_id) {
        let _ = conn.write_tx.send(data.into_bytes());
    }
    Ok(())
}

#[tauri::command]
async fn terminal_resize(
    state: State<'_, Arc<AppState>>,
    tab_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let conns = state.connections.lock().await;
    if let Some(conn) = conns.get(&tab_id) {
        let _ = conn.resize_tx.send((cols, rows));
    }
    Ok(())
}

// ==================== 设置持久化 ====================

fn get_store_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let config_dir = home.join(".jumpserverclient");
    // 确保目录存在
    let _ = std::fs::create_dir_all(&config_dir);
    config_dir.join("settings.json")
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<Value, String> {
    let path = get_store_path();
    let store = app
        .store(&path)
        .map_err(|e| format!("open store error: {}", e))?;
    let mut settings = json!({});
    for key in ["jms_url", "key_id", "secret", "user_info", "asset_tags", "asset_order", "sidebar_width", "theme", "quick_commands"] {
        if let Some(value) = store.get(key) {
            settings[key] = value;
        }
    }
    Ok(settings)
}

#[tauri::command]
async fn save_settings(app: AppHandle, settings: Value) -> Result<Value, String> {
    let path = get_store_path();
    let store = app
        .store(&path)
        .map_err(|e| format!("open store error: {}", e))?;
    if let Some(obj) = settings.as_object() {
        for (k, v) in obj {
            store.set(k, v.clone());
        }
    }
    store.save().map_err(|e| format!("save store error: {}", e))?;
    Ok(json!({ "success": true }))
}

// ==================== 应用入口 ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(Arc::new(AppState::default()))
        .invoke_handler(tauri::generate_handler![
            validate_credentials,
            get_assets,
            connect_to_asset,
            disconnect_ssh,
            disconnect_all_ssh,
            terminal_input,
            terminal_resize,
            get_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify, Semaphore};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use url::Url;

#[derive(Default)]
pub struct PatreonConnectionState(pub Mutex<Option<Arc<Control>>>);

pub struct Control {
    cancelled: AtomicBool,
    notify: Notify,
    popups: AtomicUsize,
}
impl Control {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
            popups: AtomicUsize::new(0),
        }
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    async fn stopped(&self) {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.cancelled.load(Ordering::SeqCst) {
            return;
        }
        notified.await;
    }
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: String,
    message: String,
}
fn progress(app: &tauri::AppHandle, phase: &str, message: &str) {
    let _ = app.emit_to(
        "main",
        "patreon-connection-progress",
        Progress {
            phase: phase.into(),
            message: message.into(),
        },
    );
}

pub fn relay_origin(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim())
        .map_err(|_| "Enter the HTTPS relay address supplied with your connection authorization")?;
    if url.scheme() != "https"
        || url.host_str() != Some("mhtalk-patreon.130-61-60-4.sslip.io")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || matches!(
            url.host(),
            Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_))
        )
        || url.host_str().is_some_and(|h| {
            h == "localhost"
                || h.ends_with(".localhost")
                || h.ends_with(".local")
                || h.ends_with(".invalid")
        })
    {
        return Err(
            "Relay must be a public HTTPS hostname on port 443, without a path or credentials"
                .into(),
        );
    }
    Ok(url)
}
fn json_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Could not initialize the Patreon connection".into())
}
async fn response_json(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "Relay returned an invalid response")?;
    if !status.is_success() {
        // Fixed local errors: never reflect a relay's arbitrary text or tokens into the app.
        return Err(match status.as_u16() {
            401 | 403 => "Connection authorization is invalid, expired, or not verified",
            409 => "This access authorization already has an open session. Close it or wait five minutes",
            429 => "Connection limit reached. Wait ten minutes before trying again",
            503 => "The Patreon relay is unavailable or all connections are busy",
            _ => "The Patreon relay rejected this request",
        }
        .into());
    }
    Ok(value)
}
fn field(value: &serde_json::Value, name: &str) -> Result<String, String> {
    value
        .get(name)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "Relay returned an invalid response".into())
}
fn is_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[tauri::command]
pub fn cancel_patreon_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, PatreonConnectionState>,
) {
    if let Ok(guard) = state.0.lock() {
        if let Some(control) = guard.as_ref() {
            control.cancel();
        }
    }
    close_windows(&app);
}
fn close_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("patreon-") {
            let _ = window.destroy();
        }
    }
}

// Explicitly deny remote webview permissions at WebView2 level, before navigating.
#[cfg(target_os = "windows")]
fn lock_permissions(window: &tauri::WebviewWindow) -> Result<(), String> {
    let on_failure = window.clone();
    window
        .with_webview(move |view| unsafe {
            use webview2_com::{
                Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY,
                PermissionRequestedEventHandler,
            };
            let result = view.controller().CoreWebView2().and_then(|core| {
                let mut token = 0;
                core.add_PermissionRequested(
                    &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )
            });
            // This callback precedes queued navigation. Destroy on failure; never load an unrestricted page.
            if result.is_err() {
                let _ = on_failure.destroy();
            }
        })
        .map_err(|_| "Could not restrict the private window".to_string())
}
#[cfg(not(target_os = "windows"))]
fn lock_permissions(_: &tauri::WebviewWindow) -> Result<(), String> {
    Err("Patreon private browsing currently requires Windows".into())
}

async fn verify_human(
    app: &tauri::AppHandle,
    origin: &Url,
    authorization: &str,
    control: &Arc<Control>,
    client: &reqwest::Client,
) -> Result<serde_json::Value, String> {
    progress(app, "verification", "Preparing your Patreon connection…");
    let data = response_json(
        client
            .post(origin.join("v1/attempts").unwrap())
            .json(&serde_json::json!({"accessToken":authorization}))
            .send()
            .await
            .map_err(|_| "Cannot reach the Patreon relay. Check its address and server status")?,
    )
    .await?;
    let id = field(&data, "id")?;
    let poll = field(&data, "pollToken")?;
    if !is_token(&id) || !is_token(&poll) {
        return Err("Relay returned an invalid verification session".into());
    }
    let verification = origin.join(&format!("verify/{id}")).unwrap();
    let poll_url = origin.join(&format!("v1/attempts/{id}")).unwrap();
    let expected_origin = origin.origin();
    let cancelled = control.clone();
    let window = WebviewWindowBuilder::new(app,"patreon-verify",WebviewUrl::External(Url::parse("about:blank").unwrap()))
        .title("MHTalk · Human verification").inner_size(600.0,700.0).incognito(true).devtools(false)
        .data_directory(app.path().app_local_data_dir().map_err(|_| "Cannot create isolated browser storage")?.join("verification-webview"))
        .additional_browser_args("--no-proxy-server --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp")
        .on_navigation(move |url| url.as_str()=="about:blank" || url.origin()==expected_origin)
        .on_new_window(|_,_| tauri::webview::NewWindowResponse::Deny).on_download(|_,_|false)
        .build().map_err(|_| "Cannot create the verification window")?;
    lock_permissions(&window)?;
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            cancelled.cancel();
        }
    });
    window
        .navigate(verification)
        .map_err(|_| "Cannot load human verification")?;
    progress(
        app,
        "verification",
        "Complete the human verification in the verification window.",
    );
    let result = tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            tokio::select! {
                _ = control.stopped() => return Err("Connection cancelled".into()),
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            }
            let response = client
                .post(poll_url.clone())
                .bearer_auth(&poll)
                .send()
                .await
                .map_err(|_| "Verification connection interrupted")?;
            if response.status().as_u16() == 202 {
                continue;
            }
            return response_json(response).await;
        }
    })
    .await
    .unwrap_or_else(|_| Err("Human verification timed out. Please try again".into()));
    let _ = window.destroy();
    if result.is_err() {
        let _ = client.delete(poll_url).bearer_auth(poll).send().await;
    }
    result
}

fn connect_host(request: &str) -> Result<String, String> {
    let line = request.lines().next().ok_or("Invalid proxy request")?;
    let parts: Vec<_> = line.split_whitespace().collect();
    if parts.len() != 3 || parts[0] != "CONNECT" || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0") {
        return Err("HTTPS CONNECT required".into());
    }
    let host = parts[1]
        .strip_suffix(":443")
        .ok_or("Only HTTPS port 443 is allowed")?;
    if host.len() > 253
        || !host.contains('.')
        || host.starts_with('.')
        || host.ends_with('.')
        || !host
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
    {
        return Err("Invalid destination".into());
    }
    Ok(host.into())
}
async fn tunnel(mut socket: TcpStream, origin: Url, token: String) -> Result<(), String> {
    let request = tokio::time::timeout(Duration::from_secs(10), async {
        let mut request = Vec::new();
        loop {
            let byte = socket
                .read_u8()
                .await
                .map_err(|_| "Proxy connection closed")?;
            request.push(byte);
            if request.len() > 16 * 1024 {
                return Err("Proxy request too large");
            }
            if request.ends_with(b"\r\n\r\n") {
                return Ok(request);
            }
        }
    })
    .await
    .map_err(|_| "Proxy request timed out")??;
    let host =
        match connect_host(std::str::from_utf8(&request).map_err(|_| "Invalid proxy request")?) {
            Ok(host) => host,
            Err(error) => {
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                    )
                    .await;
                return Err(error);
            }
        };
    let mut target = origin.join("v1/tunnel").unwrap();
    target.set_scheme("wss").unwrap();
    target
        .query_pairs_mut()
        .append_pair("host", &host)
        .append_pair("port", "443");
    let mut handshake = target
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid relay")?;
    handshake.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}")
            .parse()
            .map_err(|_| "Invalid token")?,
    );
    let (ws, _) = match tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(handshake),
    )
    .await
    {
        Ok(Ok(connection)) => connection,
        _ => {
            let _=socket.write_all(b"HTTP/1.1 502 Relay Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
            return Err("Relay connection failed".into());
        }
    };
    socket
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(|_| "Proxy closed")?;
    let (mut sink, mut source) = ws.split();
    let (mut reader, mut writer) = socket.split();
    let mut buffer = [0u8; 16384];
    loop {
        tokio::select! {
            read=reader.read(&mut buffer)=> {
                let length=read.map_err(|_| "Browser disconnected")?;
                if length==0 { break; }
                sink.send(Message::Binary(buffer[..length].to_vec().into())).await.map_err(|_| "Relay disconnected")?;
            }
            message=source.next()=> {
                match message {
                    Some(Ok(Message::Binary(bytes)))=>writer.write_all(&bytes).await.map_err(|_| "Browser disconnected")?,
                    Some(Ok(Message::Ping(bytes)))=>sink.send(Message::Pong(bytes)).await.map_err(|_| "Relay disconnected")?,
                    Some(Ok(Message::Pong(_)))=>{},
                    _=>break,
                }
            }
        }
    }
    Ok(())
}
async fn proxy(origin: Url, token: String, control: Arc<Control>, listener: TcpListener) {
    let slots = Arc::new(Semaphore::new(24));
    loop {
        tokio::select! {
            _=control.stopped()=>break,
            accepted=listener.accept()=> {
                let Ok((socket,_))=accepted else {break};
                let Ok(permit)=slots.clone().try_acquire_owned() else {drop(socket);continue};
                let (origin, token, control)=(origin.clone(),token.clone(),control.clone());
                tokio::spawn(async move {
                    let _permit=permit;
                    tokio::select! {
                        _=control.stopped()=>{},
                        // Includes header reads and idle tunnels. Session lifetime is also server enforced.
                        _=tokio::time::timeout(Duration::from_secs(20*60),tunnel(socket,origin,token))=>{}
                    }
                });
            }
        }
    }
}

type Callback = Result<(String, String), String>;
fn navigation(url: &Url, expected_state: &str, sender: &mpsc::UnboundedSender<Callback>) -> bool {
    if url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(8766)
        && url.path() == "/patreon/callback"
    {
        if expected_state.is_empty() {
            return false;
        }
        let values: Vec<_> = url.query_pairs().collect();
        let get = |name: &str| {
            values
                .iter()
                .filter(|(k, _)| k == name)
                .map(|(_, v)| v.to_string())
                .collect::<Vec<_>>()
        };
        let states = get("state");
        let codes = get("code");
        if states.len() != 1 || states[0] != expected_state {
            return false;
        }
        let result = if !get("error").is_empty() {
            Err("Patreon authorization was cancelled".into())
        } else if codes.len() == 1 && !codes[0].is_empty() {
            Ok((codes[0].clone(), states[0].clone()))
        } else {
            Err("Patreon returned an invalid authorization code".into())
        };
        let _ = sender.send(result);
        return false;
    }
    if url.as_str() == "about:blank" {
        return true;
    }
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && [
            "patreon.com",
            "www.patreon.com",
            "checkout.stripe.com",
            "hooks.stripe.com",
        ]
        .contains(&host)
}
#[derive(Clone)]
struct WindowContext {
    app: tauri::AppHandle,
    control: Arc<Control>,
    sender: mpsc::UnboundedSender<Callback>,
    state: String,
    directory: std::path::PathBuf,
    port: u16,
}
fn private_window(
    context: WindowContext,
    label: &str,
    target: Url,
    features: Option<tauri::webview::NewWindowFeatures>,
) -> Result<tauri::WebviewWindow, String> {
    let navigation_context = context.clone();
    let popup_context = context.clone();
    let mut builder=WebviewWindowBuilder::new(&context.app,label,WebviewUrl::External(Url::parse("about:blank").unwrap()))
        .title("MHTalk · Patreon · Private connection").inner_size(1060.0,800.0)
        .data_directory(context.directory.clone()).incognito(true).devtools(false)
        // Wry replaces its default arguments when additional_browser_args is set.
        // Set proxy here explicitly; never set a system proxy and never add DIRECT.
        .additional_browser_args(&format!("--proxy-server=http://127.0.0.1:{} --proxy-bypass-list=<-loopback> --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp --disable-features=msWebOOUI,msPdfOOUI --disable-background-networking",context.port))
        .on_navigation(move |url| navigation(url,&navigation_context.state,&navigation_context.sender))
        .on_document_title_changed(|window,_| {
            if let Ok(url)=window.url() {
                let _=window.set_title(&format!("MHTalk · {} · Private connection",url.host_str().unwrap_or("Patreon")));
            }
        })
        .on_download(|_,_|false)
        .on_new_window(move |url,features| {
            if !navigation(&url,&popup_context.state,&popup_context.sender) || popup_context.control.cancelled.load(Ordering::SeqCst) {return tauri::webview::NewWindowResponse::Deny;}
            let id=popup_context.control.popups.fetch_add(1,Ordering::SeqCst);
            if id>=4 {return tauri::webview::NewWindowResponse::Deny;}
            match private_window(popup_context.clone(),&format!("patreon-private-popup-{id}"),url,Some(features)) {
                Ok(window)=>tauri::webview::NewWindowResponse::Create {window},
                Err(_)=>tauri::webview::NewWindowResponse::Deny,
            }
        });
    let is_popup = features.is_some();
    if let Some(features) = features {
        builder = builder.window_features(features);
    }
    let window = builder
        .build()
        .map_err(|_| "Could not create the isolated Patreon window")?;
    lock_permissions(&window)?;
    if !is_popup {
        let control = context.control;
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                control.cancel();
            }
        });
        window
            .navigate(target)
            .map_err(|_| "Could not open Patreon")?;
    }
    Ok(window)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub relay_url: String,
    pub access_token: String,
}

pub async fn with_private_connection(
    app: tauri::AppHandle,
    options: Options,
    checkout: bool,
) -> Result<Option<super::PatreonLinkResult>, String> {
    let origin = relay_origin(&options.relay_url)?;
    if options.access_token.len() < 64
        || options.access_token.len() > 2048
        || !options
            .access_token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return Err("Sign in to MHTalk and start a new Patreon connection".into());
    }
    let control = Arc::new(Control::new());
    {
        let state = app.state::<PatreonConnectionState>();
        let mut current = state
            .0
            .lock()
            .map_err(|_| "Connection state is unavailable")?;
        if current.is_some() {
            return Err("A Patreon connection is already open".into());
        }
        *current = Some(control.clone());
    }
    let result = operation(
        &app,
        &origin,
        options.access_token.trim(),
        checkout,
        control.clone(),
    )
    .await;
    control.cancel();
    close_windows(&app);
    if let Ok(mut current) = app.state::<PatreonConnectionState>().0.lock() {
        *current = None;
    }
    match &result {
        Ok(_) => progress(
            &app,
            "closed",
            "Private connection closed. Membership checks use the normal secure service.",
        ),
        Err(message) => progress(&app, "error", message),
    }
    result
}
async fn operation(
    app: &tauri::AppHandle,
    origin: &Url,
    authorization: &str,
    checkout: bool,
    control: Arc<Control>,
) -> Result<Option<super::PatreonLinkResult>, String> {
    let client = json_client()?;
    let grant = verify_human(app, origin, authorization, &control, &client).await?;
    let access = field(&grant, "accessToken")?;
    if !is_token(&access) {
        return Err("Invalid relay access grant".into());
    }
    let result=async {
        if checkout && grant.get("checkout").and_then(|v|v.as_bool())!=Some(true) {return Err("Patreon checkout is temporarily unavailable".into());}
        let (target, desktop_token, expected_state)=if checkout {
            (Url::parse("https://www.patreon.com/cw/MhlkoVD/membership").unwrap(),String::new(),String::new())
        } else {
            progress(app,"connecting","Creating your secure Patreon authorization…");
            super::create_patreon_authorization(&client).await?
        };
        let listener=TcpListener::bind("127.0.0.1:0").await.map_err(|_| "Cannot open the local private connection")?;
        let port=listener.local_addr().map_err(|_| "Cannot reserve a local port")?.port();
        let task=tokio::spawn(proxy(origin.clone(),access.clone(),control.clone(),listener));
        let (sender,mut receiver)=mpsc::unbounded_channel();
        let context=WindowContext {app:app.clone(),control:control.clone(),sender,state:expected_state,
            directory:app.path().app_local_data_dir().map_err(|_| "Cannot create isolated storage")?.join(format!("patreon-webview-{port}")),port};
        private_window(context,"patreon-private",target,None)?;
        progress(app,"connected",if checkout {"Patreon is open. After payment, close it and choose Link Patreon. A payment page is not proof of membership."} else {"Sign in to Patreon and approve the link. Use your Patreon email login if an embedded Google login is rejected."});
        let expires=grant.get("expiresAt").and_then(|v|v.as_u64()).ok_or("Invalid relay expiration")?;
        let millis=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "Invalid system clock")?.as_millis() as u64;
        let timeout=Duration::from_millis(expires.saturating_sub(millis).min(20*60*1000));
        let callback=tokio::select! {
            _=control.stopped()=>if checkout {Ok(None)} else {Err("Patreon linking cancelled".into())},
            _=tokio::time::sleep(timeout)=>Err("Private session expired. Start a new connection".into()),
            returned=receiver.recv()=>match returned {Some(Ok(value))=>Ok(Some(value)),Some(Err(error))=>Err(error),None=>Err("Private window closed".into())}
        };
        control.cancel(); close_windows(app); let _=task.await;
        if let Some((code,state))=callback? {
            progress(app,"confirming","Confirming your membership with the membership service…");
            return super::complete_patreon_authorization(&client,desktop_token,code,state).await.map(Some);
        }
        Ok(None)
    }.await;
    // Revoke even when building a window or exchanging OAuth fails.
    control.cancel();
    close_windows(app);
    let _ = client
        .delete(origin.join("v1/session").unwrap())
        .bearer_auth(&access)
        .send()
        .await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    // Run explicitly against the real relay: catches TLS-provider panics that a plain
    // WebSocket echo test cannot detect. No access authorization or member credentials needed.
    #[tokio::test]
    #[ignore = "requires the deployed HTTPS relay"]
    async fn live_relay_tls_handshake_rejects_unauthenticated_access() {
        super::super::initialize_tls();
        let url =
            "wss://mhtalk-patreon.130-61-60-4.sslip.io/v1/tunnel?host=www.patreon.com&port=443";
        let result = tokio::time::timeout(
            Duration::from_secs(20),
            tokio_tungstenite::connect_async(url),
        )
        .await
        .expect("relay connection timed out");
        match result {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status().as_u16(), 401)
            }
            other => panic!("expected a trusted TLS connection and HTTP 401, got {other:?}"),
        }
    }
    #[test]
    fn rejects_untrusted_relay_shapes() {
        for value in [
            "http://relay.example",
            "https://user@relay.example",
            "https://relay.example/path",
            "https://127.0.0.1",
            "https://localhost",
            "https://relay.example:8443",
            "https://relay.example/?token=x",
        ] {
            assert!(relay_origin(value).is_err(), "{value}");
        }
        assert!(relay_origin("https://mhtalk-patreon.130-61-60-4.sslip.io").is_ok());
    }
    #[test]
    fn only_https_connect() {
        assert_eq!(
            connect_host("CONNECT www.patreon.com:443 HTTP/1.1\r\n\r\n").unwrap(),
            "www.patreon.com"
        );
        for value in [
            "GET http://patreon.com HTTP/1.1",
            "CONNECT patreon.com:80 HTTP/1.1",
            "CONNECT user@patreon.com:443 HTTP/1.1",
            "CONNECT [::1]:443 HTTP/1.1",
        ] {
            assert!(connect_host(value).is_err());
        }
    }
    #[test]
    fn callback_requires_exact_origin_state_and_single_code() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        for value in [
            "http://127.0.0.1:8766/patreon/callback?code=x&state=wrong",
            "http://evil.example/patreon/callback?code=x&state=expected",
            "mhtalk://auth/callback?code=x&state=expected",
        ] {
            assert!(!navigation(&Url::parse(value).unwrap(), "expected", &tx));
            assert!(rx.try_recv().is_err());
        }
        assert!(!navigation(
            &Url::parse("http://127.0.0.1:8766/patreon/callback?code=x&state=expected").unwrap(),
            "expected",
            &tx
        ));
        assert_eq!(
            rx.try_recv().unwrap().unwrap(),
            ("x".into(), "expected".into())
        );
        assert!(!navigation(
            &Url::parse("https://www.patreon.com.evil.example").unwrap(),
            "expected",
            &tx
        ));
    }
}

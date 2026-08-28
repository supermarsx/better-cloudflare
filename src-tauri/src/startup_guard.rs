//! Fatal-load guard for the main webview.
//!
//! When the window cannot load its page — in development the Next.js dev
//! server behind `build.devUrl` is not listening (Chromium's
//! `ERR_CONNECTION_REFUSED`), the host does not resolve, the connection times
//! out, or the initial document answers with an HTTP error — the app must not
//! sit on a blank or browser-error page. Instead it:
//!
//! 1. writes the exact failure to stderr and a redacted line to the crash log,
//! 2. shows a blocking native OS error dialog with the same text, and
//! 3. exits with [`LOAD_FAILURE_EXIT_CODE`] once the dialog is dismissed.
//!
//! A separate, earlier check covers the case where no webview can be created at
//! all: [`require_webview_runtime`] runs before `tauri::Builder::build()` and
//! reports a missing Microsoft Edge WebView2 runtime through the same dialog.
//! Without it that failure surfaces only on stderr, which is invisible for a
//! windowed process — the portable Windows build would appear to do nothing.
//!
//! Two independent detectors then feed one classifier:
//!
//! * **Pre-flight probe** (all platforms, dev builds only): before the window
//!   has a chance to render, a TCP connect to the `devUrl` host and port maps
//!   `ConnectionRefused` / DNS / timeout failures to the message.
//! * **WebView2 `NavigationCompleted`** (Windows): the raw `ICoreWebView2`
//!   reports `IsSuccess`, `WebErrorStatus` and the HTTP status for every
//!   *top-level* navigation. Sub-resources and iframes never reach this event,
//!   so transient asset failures cannot trigger the dialog. A navigation that
//!   was cancelled because another one replaced it (`OPERATION_CANCELED`) is
//!   ignored for the same reason.
//!
//! Only network-level failures are fatal for later navigations; HTTP error
//! documents are fatal only for the first one, so an in-app route that 404s
//! after start-up is left to the frontend.

use std::fmt;
use std::io;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri::Manager;

/// Process exit status after the user dismisses the fatal dialog. Distinct
/// from `1`, which `main` uses for a Tauri run error or panic.
pub const LOAD_FAILURE_EXIT_CODE: i32 = 2;

/// Title of the native dialog.
pub const DIALOG_TITLE: &str = "Better Cloudflare could not start";

/// Category written to the redacted crash log.
pub const CRASH_CATEGORY: &str = "webview-load-failure";

const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(3);

/// A classified failure to load the main document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadFailure {
    /// The URL the webview attempted.
    pub url: String,
    /// Chromium-style error name, e.g. `ERR_CONNECTION_REFUSED`.
    pub error_name: &'static str,
    /// Where the error came from, verbatim (`WebView2 …`, `TCP connect …`).
    pub source_detail: String,
    /// HTTP status of the document, if the server answered at all.
    pub http_status: Option<i32>,
    /// Plain-language cause and what to do about it.
    pub cause: String,
}

impl LoadFailure {
    /// The full text shown in the dialog and written to stderr.
    pub fn dialog_text(&self) -> String {
        let mut text = format!(
            "The application window could not load its page and the application will now exit.\n\nError: {}\nURL: {}\n",
            self.error_name, self.url
        );
        if let Some(status) = self.http_status {
            text.push_str(&format!("HTTP status: {status}\n"));
        }
        text.push_str(&format!(
            "Reported by: {}\n\nCause: {}",
            self.source_detail, self.cause
        ));
        text
    }
}

impl fmt::Display for LoadFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.dialog_text())
    }
}

/// What a completed top-level navigation reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavigationOutcome {
    pub url: String,
    pub is_success: bool,
    /// Raw `COREWEBVIEW2_WEB_ERROR_STATUS` value.
    pub web_error_status: i32,
    pub http_status: Option<i32>,
}

/// One row of the WebView2 `COREWEBVIEW2_WEB_ERROR_STATUS` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebErrorInfo {
    pub constant: &'static str,
    pub chromium_name: &'static str,
    pub description: &'static str,
}

/// Maps a `COREWEBVIEW2_WEB_ERROR_STATUS` value to its name, the Chromium
/// `net::` error users see in the browser error page, and a description.
/// The numeric values are the SDK's own and are stable.
pub fn describe_web_error_status(raw: i32) -> WebErrorInfo {
    let (constant, chromium_name, description) = match raw {
        0 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN",
            "ERR_FAILED",
            "an unknown error occurred",
        ),
        1 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT",
            "ERR_CERT_COMMON_NAME_INVALID",
            "the SSL certificate common name does not match the host",
        ),
        2 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED",
            "ERR_CERT_DATE_INVALID",
            "the SSL certificate has expired",
        ),
        3 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS",
            "ERR_BAD_SSL_CLIENT_AUTH_CERT",
            "the client certificate contains errors",
        ),
        4 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED",
            "ERR_CERT_REVOKED",
            "the SSL certificate has been revoked",
        ),
        5 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID",
            "ERR_CERT_INVALID",
            "the SSL certificate is invalid",
        ),
        6 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE",
            "ERR_ADDRESS_UNREACHABLE",
            "the host is unreachable",
        ),
        7 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT",
            "ERR_CONNECTION_TIMED_OUT",
            "the connection timed out",
        ),
        8 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_ERROR_HTTP_INVALID_SERVER_RESPONSE",
            "ERR_INVALID_RESPONSE",
            "the server returned an invalid or unrecognised response",
        ),
        9 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED",
            "ERR_CONNECTION_ABORTED",
            "the connection was aborted",
        ),
        10 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET",
            "ERR_CONNECTION_RESET",
            "the connection was reset",
        ),
        11 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED",
            "ERR_INTERNET_DISCONNECTED",
            "the network connection is down",
        ),
        12 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT",
            "ERR_CONNECTION_REFUSED",
            "nothing is accepting connections on that host and port",
        ),
        13 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED",
            "ERR_NAME_NOT_RESOLVED",
            "the host name could not be resolved",
        ),
        14 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED",
            "ERR_ABORTED",
            "the navigation was cancelled",
        ),
        15 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_REDIRECT_FAILED",
            "ERR_TOO_MANY_REDIRECTS",
            "the redirect could not be followed",
        ),
        16 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_UNEXPECTED_ERROR",
            "ERR_UNEXPECTED",
            "an unexpected error occurred",
        ),
        17 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_VALID_AUTHENTICATION_CREDENTIALS_REQUIRED",
            "ERR_INVALID_AUTH_CREDENTIALS",
            "the server requires valid authentication credentials",
        ),
        18 => (
            "COREWEBVIEW2_WEB_ERROR_STATUS_VALID_PROXY_AUTHENTICATION_REQUIRED",
            "ERR_PROXY_AUTH_REQUESTED",
            "the proxy requires valid authentication credentials",
        ),
        _ => (
            "COREWEBVIEW2_WEB_ERROR_STATUS (unlisted value)",
            "ERR_FAILED",
            "WebView2 reported an error status this build does not know",
        ),
    };
    WebErrorInfo {
        constant,
        chromium_name,
        description,
    }
}

const WEB_ERROR_OPERATION_CANCELED: i32 = 14;

/// Whether the URL is served by Tauri's own asset protocol (production build).
fn is_bundled_origin(url: &str) -> bool {
    url.starts_with("tauri://")
        || url.starts_with("http://tauri.localhost")
        || url.starts_with("https://tauri.localhost")
}

fn origin_of(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => {
            let mut origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
            if let Some(port) = parsed.port() {
                origin.push_str(&format!(":{port}"));
            }
            origin
        }
        Err(_) => url.to_string(),
    }
}

/// Plain-language explanation for a page that could not be fetched at all.
pub fn connection_cause(url: &str, is_dev: bool) -> String {
    if is_bundled_origin(url) {
        return "The bundled frontend could not be served. The static export in \
                src-tauri's frontendDist (../out) is missing or incomplete; run \
                `npm run build` and rebuild the application."
            .to_string();
    }
    let origin = origin_of(url);
    if is_dev {
        format!(
            "The development server on {origin} is not running, has stopped, or is \
             not reachable on that port (it may have been started on a different \
             port, or the port is held by another program). Start the app with \
             `npm run tauri:dev` (scripts/tauri-dev.mjs starts Next.js on a free \
             port and points the window at it), or check scripts/tauri-before-dev.mjs \
             when running `tauri dev` directly."
        )
    } else {
        format!("The server on {origin} did not accept the connection.")
    }
}

/// Plain-language explanation for a document that arrived with an HTTP error.
pub fn http_cause(url: &str, status: i32, is_dev: bool) -> String {
    if is_bundled_origin(url) {
        return format!(
            "The bundled frontend answered HTTP {status} for the start page. The \
             static export (frontendDist ../out) does not contain index.html; run \
             `npm run build` and rebuild the application."
        );
    }
    let origin = origin_of(url);
    if is_dev {
        format!(
            "The development server on {origin} answered HTTP {status} instead of the \
             application page. Check the Next.js dev server output for a compile or \
             runtime error, then restart with `npm run tauri:dev`."
        )
    } else {
        format!("The server on {origin} answered HTTP {status} instead of the application page.")
    }
}

/// Decides whether a completed top-level navigation is fatal.
///
/// `is_initial` marks the first navigation the window ever completed; HTTP
/// error documents are only fatal then.
pub fn evaluate_navigation(
    outcome: &NavigationOutcome,
    is_initial: bool,
    is_dev: bool,
) -> Option<LoadFailure> {
    if !outcome.is_success {
        if outcome.web_error_status == WEB_ERROR_OPERATION_CANCELED {
            return None;
        }
        let info = describe_web_error_status(outcome.web_error_status);
        let http_failure =
            outcome.web_error_status == 0 && outcome.http_status.is_some_and(|s| s >= 400);
        if http_failure {
            let status = outcome.http_status.unwrap_or_default();
            return Some(LoadFailure {
                url: outcome.url.clone(),
                error_name: "ERR_HTTP_RESPONSE_CODE_FAILURE",
                source_detail: format!(
                    "WebView2 NavigationCompleted IsSuccess=false, WebErrorStatus={} ({}), HttpStatusCode={status}",
                    info.constant, outcome.web_error_status
                ),
                http_status: outcome.http_status,
                cause: http_cause(&outcome.url, status, is_dev),
            });
        }
        return Some(LoadFailure {
            url: outcome.url.clone(),
            error_name: info.chromium_name,
            source_detail: format!(
                "WebView2 NavigationCompleted IsSuccess=false, WebErrorStatus={} ({}): {}",
                info.constant, outcome.web_error_status, info.description
            ),
            http_status: outcome.http_status,
            cause: connection_cause(&outcome.url, is_dev),
        });
    }

    if is_initial {
        if let Some(status) = outcome.http_status.filter(|s| *s >= 400) {
            return Some(LoadFailure {
                url: outcome.url.clone(),
                error_name: "ERR_HTTP_RESPONSE_CODE_FAILURE",
                source_detail: format!(
                    "WebView2 NavigationCompleted IsSuccess=true, HttpStatusCode={status}"
                ),
                http_status: Some(status),
                cause: http_cause(&outcome.url, status, is_dev),
            });
        }
    }
    None
}

/// Result of the dev-server pre-flight probe.
#[derive(Debug, PartialEq, Eq)]
pub enum Preflight {
    /// The URL is not something we probe (bundled origin, non-http scheme, no host).
    Skipped,
    /// A TCP connection was accepted.
    Reachable,
    Failed(LoadFailure),
}

/// Classifies a failed TCP connect for the pre-flight probe.
pub fn classify_preflight_error(
    url: &str,
    addr: &str,
    error: &io::Error,
    is_dev: bool,
) -> LoadFailure {
    let error_name = match error.kind() {
        io::ErrorKind::ConnectionRefused => "ERR_CONNECTION_REFUSED",
        io::ErrorKind::TimedOut => "ERR_CONNECTION_TIMED_OUT",
        io::ErrorKind::ConnectionReset => "ERR_CONNECTION_RESET",
        io::ErrorKind::ConnectionAborted => "ERR_CONNECTION_ABORTED",
        io::ErrorKind::NotFound => "ERR_NAME_NOT_RESOLVED",
        _ => "ERR_CONNECTION_FAILED",
    };
    LoadFailure {
        url: url.to_string(),
        error_name,
        source_detail: format!(
            "TCP connect to {addr}: {error} (io::ErrorKind::{:?})",
            error.kind()
        ),
        http_status: None,
        cause: connection_cause(url, is_dev),
    }
}

/// Connects to the dev URL's host and port once. Runs before the webview can
/// render so the dialog appears instead of a browser error page.
pub fn preflight_dev_url(url: &str, is_dev: bool) -> Preflight {
    if is_bundled_origin(url) {
        return Preflight::Skipped;
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return Preflight::Skipped;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return Preflight::Skipped;
    }
    let Some(host) = parsed.host_str() else {
        return Preflight::Skipped;
    };
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addr = format!("{host}:{port}");

    let resolved: Vec<SocketAddr> = match addr.to_socket_addrs() {
        Ok(iter) => iter.collect(),
        Err(error) => {
            let error = io::Error::new(io::ErrorKind::NotFound, error.to_string());
            return Preflight::Failed(classify_preflight_error(url, &addr, &error, is_dev));
        }
    };

    let mut last_error: Option<io::Error> = None;
    for socket in resolved {
        match TcpStream::connect_timeout(&socket, PREFLIGHT_TIMEOUT) {
            Ok(_) => return Preflight::Reachable,
            Err(error) => last_error = Some(error),
        }
    }
    let error = last_error
        .unwrap_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no addresses resolved"));
    Preflight::Failed(classify_preflight_error(url, &addr, &error, is_dev))
}

/// WebView2 frequently reports `COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN` for a
/// refused connection (observed on a reload after the dev server stopped).
/// When that happens a TCP probe of the same URL, taken immediately after the
/// failure, supplies the exact error instead of the generic `ERR_FAILED`.
pub fn refine_unknown_failure(failure: LoadFailure, probe: Preflight) -> LoadFailure {
    if failure.error_name != "ERR_FAILED" {
        return failure;
    }
    match probe {
        Preflight::Failed(probed) => LoadFailure {
            url: failure.url,
            error_name: probed.error_name,
            source_detail: format!("{}; {}", failure.source_detail, probed.source_detail),
            http_status: failure.http_status,
            cause: probed.cause,
        },
        Preflight::Reachable | Preflight::Skipped => failure,
    }
}

/// Logs the failure, shows the blocking native dialog, and exits the process.
/// Never returns.
pub fn fail_fast(failure: &LoadFailure) -> ! {
    fatal(
        CRASH_CATEGORY,
        format!("navigation:{}", failure.error_name),
        &failure.dialog_text(),
    )
}

/// Shared exit path: redacted log, stderr copy, blocking native dialog, exit.
///
/// This is deliberately the only way the guard terminates. `rfd` shows an OS
/// message box, not a webview, so it still works when the reason for exiting is
/// that no webview can be created at all.
fn fatal(category: &'static str, location: String, text: &str) -> ! {
    crate::write_stderr(&format!("[startup-guard] {DIALOG_TITLE}\n{text}\n"));
    let record = crate::CrashRecord {
        timestamp_unix: crate::unix_timestamp(),
        category,
        location,
    };
    let _ = crate::persist_crash_record(&crate::crash_log_path(), &record);

    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(DIALOG_TITLE)
        .set_description(text)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();

    std::process::exit(LOAD_FAILURE_EXIT_CODE)
}

/// Category written to the redacted crash log when the WebView2 runtime is
/// absent. Distinct from [`CRASH_CATEGORY`] because nothing was ever loaded.
pub const MISSING_WEBVIEW_CATEGORY: &str = "webview2-runtime-missing";

/// Text shown when the Microsoft Edge WebView2 runtime is missing.
///
/// Kept separate from [`LoadFailure`] because there is no URL, no HTTP status
/// and no navigation to describe: the window is never created.
///
/// Only Windows can reach this, but the text is asserted by a test that runs on
/// every platform, so it is compiled for tests too. Without the gate it would
/// be dead code on Linux, which CI rejects with `-D warnings`.
#[cfg(any(windows, test))]
pub fn missing_webview_text() -> String {
    concat!(
        "The application window could not be created and the application will ",
        "now exit.\n\nThe Microsoft Edge WebView2 runtime is required, and it ",
        "is not installed on this computer.\n\nInstall the Evergreen WebView2 ",
        "Runtime from:\nhttps://developer.microsoft.com/microsoft-edge/webview2/",
        "\n\nThe Better Cloudflare installers add this runtime for you. The ",
        "portable executable cannot, because it does not run an installer."
    )
    .to_string()
}

/// Reports the installed WebView2 runtime version, or `None` when no runtime is
/// available.
///
/// `GetAvailableCoreWebView2BrowserVersionString` is the loader's own probe: it
/// fails when the runtime is not registered, and can also succeed while
/// reporting no version, which counts as absent.
#[cfg(windows)]
pub fn webview2_runtime_version() -> Option<String> {
    use webview2_com::CoTaskMemPWSTR;
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    use windows::core::{PCWSTR, PWSTR};

    let mut raw = PWSTR::null();
    // SAFETY: `raw` is a valid out-pointer. Ownership of any returned buffer is
    // handed straight to `CoTaskMemPWSTR`, which frees it with CoTaskMemFree.
    let result = unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut raw) };
    let owned = CoTaskMemPWSTR::from(raw);
    if result.is_err() || raw.is_null() {
        return None;
    }
    let version = owned.to_string();
    if version.is_empty() {
        return None;
    }
    Some(version)
}

/// Exits with the standard native dialog when the WebView2 runtime is missing.
///
/// Must run *before* `tauri::Builder::build()`. Without it, a missing runtime
/// makes `build()` return an error that `main` can only report on stderr, which
/// is invisible for a windowed process started from Explorer — so a portable
/// build would appear to do nothing at all.
#[cfg(windows)]
pub fn require_webview_runtime() {
    if webview2_runtime_version().is_none() {
        fatal(
            MISSING_WEBVIEW_CATEGORY,
            "startup:webview2-runtime".to_string(),
            &missing_webview_text(),
        );
    }
}

/// Non-Windows platforms link their webview at load time, so a missing engine
/// is a loader error before `main` runs and cannot be probed here.
#[cfg(not(windows))]
pub fn require_webview_runtime() {}

/// Installs both detectors on the main window. Safe to call when the window
/// does not exist (tests with a mock runtime): it then does nothing.
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let is_dev = tauri::is_dev();

    if is_dev {
        if let Some(dev_url) = app.config().build.dev_url.as_ref() {
            if let Preflight::Failed(failure) = preflight_dev_url(dev_url.as_str(), is_dev) {
                fail_fast(&failure);
            }
        }
    }

    #[cfg(windows)]
    windows_hook::install(&window, is_dev);
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod windows_hook {
    use super::{
        evaluate_navigation, fail_fast, preflight_dev_url, refine_unknown_failure,
        NavigationOutcome,
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2NavigationCompletedEventArgs,
        ICoreWebView2NavigationCompletedEventArgs2,
    };
    use webview2_com::{take_pwstr, NavigationCompletedEventHandler};
    use windows::core::{Interface, BOOL, PWSTR};

    fn read_outcome(
        webview: &ICoreWebView2,
        args: &ICoreWebView2NavigationCompletedEventArgs,
    ) -> windows::core::Result<NavigationOutcome> {
        // SAFETY: plain COM getters on live interface pointers handed to the
        // callback by WebView2; every out-parameter is a local we own.
        unsafe {
            let mut source = PWSTR::null();
            webview.Source(&mut source)?;
            let url = take_pwstr(source);

            let mut is_success = BOOL(0);
            args.IsSuccess(&mut is_success)?;

            let mut status = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS::default();
            args.WebErrorStatus(&mut status)?;

            let http_status = args
                .cast::<ICoreWebView2NavigationCompletedEventArgs2>()
                .ok()
                .and_then(|args2| {
                    let mut code = 0i32;
                    args2.HttpStatusCode(&mut code).ok().map(|_| code)
                })
                .filter(|code| *code != 0);

            Ok(NavigationOutcome {
                url,
                is_success: is_success.as_bool(),
                web_error_status: status.0,
                http_status,
            })
        }
    }

    pub fn install<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, is_dev: bool) {
        let result = window.with_webview(move |platform| {
            let mut completed_navigations = 0u32;
            let handler = NavigationCompletedEventHandler::create(Box::new(move |webview, args| {
                let (Some(webview), Some(args)) = (webview, args) else {
                    return Ok(());
                };
                let outcome = read_outcome(&webview, &args)?;
                completed_navigations += 1;
                if let Some(failure) = evaluate_navigation(&outcome, completed_navigations == 1, is_dev) {
                    let probe = preflight_dev_url(&failure.url, is_dev);
                    fail_fast(&refine_unknown_failure(failure, probe));
                }
                Ok(())
            }));
            // SAFETY: the controller comes from the live webview on its own
            // thread; the token is an out-parameter we never need again because
            // the handler lives as long as the webview.
            let registered: windows::core::Result<()> = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    let mut token = 0i64;
                    core.add_NavigationCompleted(&handler, &mut token)
                })
            };
            if let Err(error) = registered {
                crate::write_stderr(&format!(
                    "[startup-guard] could not attach the WebView2 NavigationCompleted handler: {error}\n"
                ));
            }
        });
        if let Err(error) = result {
            crate::write_stderr(&format!(
                "[startup-guard] could not reach the platform webview: {error}\n"
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(url: &str, is_success: bool, status: i32, http: Option<i32>) -> NavigationOutcome {
        NavigationOutcome {
            url: url.to_string(),
            is_success,
            web_error_status: status,
            http_status: http,
        }
    }

    #[test]
    fn cannot_connect_maps_to_err_connection_refused_with_dev_hint() {
        let failure = evaluate_navigation(
            &outcome("http://localhost:3999/", false, 12, None),
            true,
            true,
        )
        .expect("a refused connection is fatal");
        assert_eq!(failure.error_name, "ERR_CONNECTION_REFUSED");
        assert_eq!(failure.url, "http://localhost:3999/");
        assert!(failure
            .source_detail
            .contains("COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT"));
        assert!(failure.source_detail.contains("(12)"));
        assert!(failure.cause.contains("http://localhost:3999"));
        assert!(failure.cause.contains("npm run tauri:dev"));
        assert!(failure.cause.contains("scripts/tauri-dev.mjs"));

        let text = failure.dialog_text();
        assert!(text.contains("Error: ERR_CONNECTION_REFUSED"));
        assert!(text.contains("URL: http://localhost:3999/"));
        assert!(!text.contains("HTTP status"));
        assert!(text.contains("will now exit"));
    }

    #[test]
    fn every_documented_status_has_a_name() {
        for raw in 0..=18 {
            let info = describe_web_error_status(raw);
            assert!(
                info.constant.starts_with("COREWEBVIEW2_WEB_ERROR_STATUS_"),
                "{raw}"
            );
            assert!(info.chromium_name.starts_with("ERR_"), "{raw}");
        }
        assert_eq!(
            describe_web_error_status(13).chromium_name,
            "ERR_NAME_NOT_RESOLVED"
        );
        assert_eq!(
            describe_web_error_status(7).chromium_name,
            "ERR_CONNECTION_TIMED_OUT"
        );
        assert_eq!(describe_web_error_status(99).chromium_name, "ERR_FAILED");
    }

    #[test]
    fn cancelled_navigation_is_not_fatal() {
        assert_eq!(
            evaluate_navigation(
                &outcome("http://localhost:3000/", false, 14, None),
                true,
                true
            ),
            None
        );
        assert_eq!(
            evaluate_navigation(
                &outcome("http://localhost:3000/", false, 14, None),
                false,
                true
            ),
            None
        );
    }

    #[test]
    fn successful_navigation_is_not_fatal() {
        assert_eq!(
            evaluate_navigation(
                &outcome("http://localhost:3000/", true, 0, Some(200)),
                true,
                true
            ),
            None
        );
        assert_eq!(
            evaluate_navigation(
                &outcome("http://tauri.localhost/", true, 0, None),
                true,
                false
            ),
            None
        );
    }

    #[test]
    fn http_error_on_initial_document_is_fatal_but_later_ones_are_not() {
        let failure = evaluate_navigation(
            &outcome("http://tauri.localhost/", true, 0, Some(404)),
            true,
            false,
        )
        .expect("initial 404 is fatal");
        assert_eq!(failure.error_name, "ERR_HTTP_RESPONSE_CODE_FAILURE");
        assert_eq!(failure.http_status, Some(404));
        assert!(failure.cause.contains("npm run build"));
        assert!(failure.dialog_text().contains("HTTP status: 404"));

        assert_eq!(
            evaluate_navigation(
                &outcome("http://localhost:3000/x", true, 0, Some(404)),
                false,
                true
            ),
            None
        );
    }

    #[test]
    fn http_error_page_with_unknown_status_reports_the_http_code() {
        let failure = evaluate_navigation(
            &outcome("http://localhost:3000/", false, 0, Some(500)),
            true,
            true,
        )
        .expect("500 error page is fatal");
        assert_eq!(failure.error_name, "ERR_HTTP_RESPONSE_CODE_FAILURE");
        assert!(failure.source_detail.contains("HttpStatusCode=500"));
        assert!(failure.cause.contains("HTTP 500"));
        assert!(failure.cause.contains("Next.js"));
    }

    #[test]
    fn network_failure_on_a_later_navigation_is_still_fatal() {
        let failure = evaluate_navigation(
            &outcome("http://localhost:3000/", false, 12, None),
            false,
            true,
        )
        .expect("dev server died after start-up");
        assert_eq!(failure.error_name, "ERR_CONNECTION_REFUSED");
    }

    #[test]
    fn bundled_origin_gets_the_rebuild_hint() {
        let cause = connection_cause("http://tauri.localhost/", false);
        assert!(cause.contains("frontendDist"));
        assert!(cause.contains("npm run build"));
        let cause = connection_cause("tauri://localhost/", false);
        assert!(cause.contains("frontendDist"));
    }

    #[test]
    fn preflight_errors_are_classified_by_io_kind() {
        let refused = io::Error::new(
            io::ErrorKind::ConnectionRefused,
            "No connection could be made",
        );
        let failure =
            classify_preflight_error("http://localhost:3999", "localhost:3999", &refused, true);
        assert_eq!(failure.error_name, "ERR_CONNECTION_REFUSED");
        assert!(failure
            .source_detail
            .contains("TCP connect to localhost:3999"));
        assert!(failure
            .source_detail
            .contains("No connection could be made"));
        assert!(failure.source_detail.contains("ConnectionRefused"));

        let timeout = io::Error::new(io::ErrorKind::TimedOut, "timed out");
        assert_eq!(
            classify_preflight_error("http://x", "x:80", &timeout, true).error_name,
            "ERR_CONNECTION_TIMED_OUT"
        );
        let dns = io::Error::new(io::ErrorKind::NotFound, "no such host");
        assert_eq!(
            classify_preflight_error("http://x", "x:80", &dns, true).error_name,
            "ERR_NAME_NOT_RESOLVED"
        );
    }

    #[test]
    fn preflight_skips_bundled_and_non_http_urls() {
        assert_eq!(
            preflight_dev_url("http://tauri.localhost/", false),
            Preflight::Skipped
        );
        assert_eq!(
            preflight_dev_url("tauri://localhost/", false),
            Preflight::Skipped
        );
        assert_eq!(
            preflight_dev_url("file:///index.html", true),
            Preflight::Skipped
        );
        assert_eq!(preflight_dev_url("not a url", true), Preflight::Skipped);
    }

    #[test]
    fn preflight_detects_a_refused_port_and_a_listening_one() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        assert_eq!(
            preflight_dev_url(&format!("http://127.0.0.1:{port}/"), true),
            Preflight::Reachable
        );
        drop(listener);

        match preflight_dev_url(&format!("http://127.0.0.1:{port}/"), true) {
            Preflight::Failed(failure) => {
                assert_eq!(failure.error_name, "ERR_CONNECTION_REFUSED");
                assert_eq!(failure.url, format!("http://127.0.0.1:{port}/"));
                assert!(failure.cause.contains(&format!("http://127.0.0.1:{port}")));
            }
            other => panic!("expected a refused connection, got {other:?}"),
        }
    }

    #[test]
    fn unknown_status_is_refined_by_the_tcp_probe() {
        let failure = evaluate_navigation(
            &outcome("http://localhost:3999/", false, 0, None),
            false,
            true,
        )
        .expect("fatal");
        assert_eq!(failure.error_name, "ERR_FAILED");

        let refused = io::Error::new(io::ErrorKind::ConnectionRefused, "actively refused");
        let probe = Preflight::Failed(classify_preflight_error(
            "http://localhost:3999/",
            "localhost:3999",
            &refused,
            true,
        ));
        let refined = refine_unknown_failure(failure.clone(), probe);
        assert_eq!(refined.error_name, "ERR_CONNECTION_REFUSED");
        assert!(refined.source_detail.contains("WEB_ERROR_STATUS_UNKNOWN"));
        assert!(refined.source_detail.contains("actively refused"));
        assert!(refined.cause.contains("npm run tauri:dev"));

        assert_eq!(
            refine_unknown_failure(failure.clone(), Preflight::Reachable),
            failure
        );
        let known = evaluate_navigation(
            &outcome("http://localhost:3999/", false, 13, None),
            true,
            true,
        )
        .expect("fatal");
        assert_eq!(
            refine_unknown_failure(known.clone(), Preflight::Skipped).error_name,
            "ERR_NAME_NOT_RESOLVED"
        );
    }

    #[test]
    fn crash_log_location_never_contains_the_url() {
        let failure = evaluate_navigation(
            &outcome("http://localhost:3999/?token=secret", false, 12, None),
            true,
            true,
        )
        .expect("fatal");
        let location = format!("navigation:{}", failure.error_name);
        assert_eq!(location, "navigation:ERR_CONNECTION_REFUSED");
        assert!(!location.contains("secret"));
    }

    #[test]
    fn missing_webview_text_names_the_runtime_and_where_to_get_it() {
        let text = missing_webview_text();
        assert!(text.contains("WebView2"));
        assert!(text.contains("https://developer.microsoft.com/microsoft-edge/webview2/"));
        // The portable build is the one that cannot install the runtime, so the
        // dialog has to say so rather than leaving the user stuck.
        assert!(text.contains("portable"));
        // Distinct category: nothing was loaded, so this is not a load failure.
        assert_ne!(MISSING_WEBVIEW_CATEGORY, CRASH_CATEGORY);
        assert!(!MISSING_WEBVIEW_CATEGORY.is_empty());
    }

    /// The probe must agree with reality on a machine that has the runtime.
    /// Every Windows CI runner and dev box that can build this app has it.
    #[cfg(windows)]
    #[test]
    fn webview2_probe_finds_the_installed_runtime() {
        let version = webview2_runtime_version()
            .expect("a Windows host building this app has the WebView2 runtime");
        assert!(
            version.chars().next().is_some_and(|c| c.is_ascii_digit()),
            "unexpected WebView2 version string: {version}"
        );
    }
}

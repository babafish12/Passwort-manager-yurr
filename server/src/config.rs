use std::sync::OnceLock;
use std::time::Duration;
use std::{net::IpAddr, str::FromStr};

pub const SERVER_PORT: u16 = 8443;
pub const SERVER_ADDR: &str = "0.0.0.0";
pub const CORS_ALLOWED_ORIGINS_ENV: &str = "YURRR_CORS_ALLOWED_ORIGINS";

// JWT + session timeout defaults
pub const DEFAULT_JWT_EXPIRY_HOURS: u64 = 24;
pub const DEFAULT_INACTIVITY_TIMEOUT_MINUTES: u64 = 240;

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

pub fn jwt_expiry_hours() -> u64 {
    static VALUE: OnceLock<u64> = OnceLock::new();
    *VALUE.get_or_init(|| env_u64("YURRR_JWT_EXPIRY_HOURS").unwrap_or(DEFAULT_JWT_EXPIRY_HOURS))
}

pub fn inactivity_timeout() -> Duration {
    static VALUE: OnceLock<Duration> = OnceLock::new();
    *VALUE.get_or_init(|| {
        let minutes = env_u64("YURRR_INACTIVITY_TIMEOUT_MINUTES")
            .unwrap_or(DEFAULT_INACTIVITY_TIMEOUT_MINUTES);
        Duration::from_secs(minutes * 60)
    })
}

fn configured_cors_origins() -> &'static [String] {
    static VALUE: OnceLock<Vec<String>> = OnceLock::new();
    VALUE.get_or_init(|| {
        std::env::var(CORS_ALLOWED_ORIGINS_ENV)
            .ok()
            .map(|raw| {
                raw.split(',')
                    .filter_map(normalize_cors_origin)
                    .filter(|origin| origin != "*")
                    .collect()
            })
            .unwrap_or_default()
    })
}

fn normalize_cors_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    let url = url::Url::parse(trimmed).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host
    };
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();

    Some(format!(
        "{}://{}{}",
        url.scheme().to_ascii_lowercase(),
        host,
        port
    ))
}

fn is_private_or_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            let first_segment = ip.segments()[0];
            ip.is_loopback()
                || (first_segment & 0xfe00) == 0xfc00
                || (first_segment & 0xffc0) == 0xfe80
        }
    }
}

fn is_local_or_private_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }

    IpAddr::from_str(&host)
        .map(is_private_or_local_ip)
        .unwrap_or(false)
}

pub fn is_cors_origin_allowed(origin: &str) -> bool {
    let Some(normalized) = normalize_cors_origin(origin) else {
        return false;
    };

    let configured_origins = configured_cors_origins();
    if !configured_origins.is_empty() {
        return configured_origins
            .iter()
            .any(|allowed| allowed == &normalized);
    }

    let Ok(url) = url::Url::parse(&normalized) else {
        return false;
    };

    match url.scheme() {
        "chrome-extension" | "moz-extension" | "safari-web-extension" => true,
        "http" | "https" => url
            .host_str()
            .map(is_local_or_private_host)
            .unwrap_or(false),
        _ => false,
    }
}

// Argon2id parameters (tuned for Raspberry Pi)
pub const ARGON2_M_COST: u32 = 16384; // 16 MB
pub const ARGON2_T_COST: u32 = 2;
pub const ARGON2_P_COST: u32 = 2;

// Rate limiting
pub const LOGIN_RATE_LIMIT_PER_SECOND: u64 = 5;
pub const LOGIN_RATE_LIMIT_BURST: u32 = 5;

// Database
pub const DB_PATH: &str = "vault.db";
pub const CERTS_DIR: &str = "certs";

// Password generator defaults
pub const DEFAULT_PASSWORD_LENGTH: usize = 20;

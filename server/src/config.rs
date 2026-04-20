use std::sync::OnceLock;
use std::time::Duration;

pub const SERVER_PORT: u16 = 8443;
pub const SERVER_ADDR: &str = "0.0.0.0";

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
    *VALUE.get_or_init(|| {
        env_u64("YURRR_JWT_EXPIRY_HOURS").unwrap_or(DEFAULT_JWT_EXPIRY_HOURS)
    })
}

pub fn inactivity_timeout() -> Duration {
    static VALUE: OnceLock<Duration> = OnceLock::new();
    *VALUE.get_or_init(|| {
        let minutes = env_u64("YURRR_INACTIVITY_TIMEOUT_MINUTES")
            .unwrap_or(DEFAULT_INACTIVITY_TIMEOUT_MINUTES);
        Duration::from_secs(minutes * 60)
    })
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

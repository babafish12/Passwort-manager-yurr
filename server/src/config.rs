use std::time::Duration;

pub const SERVER_PORT: u16 = 8443;
pub const SERVER_ADDR: &str = "0.0.0.0";

// JWT
pub const JWT_EXPIRY_HOURS: u64 = 1;
pub const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(15 * 60); // 15 minutes

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

export const DEFAULT_SERVER_URL = 'https://localhost:8443';
export const API_BASE = '/api/v1';
export const AUTO_LOCK_MINUTES = 15;
export const STORAGE_KEY_SERVER_URL = 'yurrr_server_url';
export const STORAGE_KEY_TOKEN = 'yurrr_token';
export const STORAGE_KEY_TOKEN_SERVER_URL = 'yurrr_token_server_url';
export const STORAGE_KEY_SESSION_MODE = 'yurrr_session_mode';
export const STORAGE_KEY_LAST_ACTIVE = 'yurrr_last_active';
export const STORAGE_KEY_AUTO_LOCK_EXPIRES_AT = 'yurrr_auto_lock_expires_at';
export const STORAGE_KEY_AUTO_LOCK_MINUTES = 'yurrr_auto_lock_minutes';
export const STORAGE_KEY_EMAIL_SUGGESTIONS = 'yurrr_email_suggestions';
export const STORAGE_KEY_AUTOFILL_ENABLED = 'yurrr_autofill_enabled';
export const STORAGE_KEY_LAST_SELECTED_CREDENTIALS = 'yurrr_last_selected_credentials';
export const STORAGE_KEY_CREDENTIAL_METADATA_CACHE = 'yurrr_credential_metadata_cache';
export const STORAGE_KEY_POPUP_CACHE = 'yurrr_popup_cache';
export const POPUP_CACHE_TTL_MS = 5 * 60 * 1000;
export const POPUP_CACHE_REFRESH_MS = 30 * 1000;
export const POPUP_CACHE_MAX_DETAILS = 20;
export const POPUP_CACHE_ALARM = 'popup-cache-expiry';
export const STORAGE_KEY_PENDING_CREDENTIALS = 'yurrr_pending_credentials';
export const STORAGE_KEY_PENDING_USERNAMES = 'yurrr_pending_usernames';
export const STORAGE_KEY_CARDS = 'yurrr_cards';
export const STORAGE_KEY_ADDRESSES = 'yurrr_addresses';
export const SESSION_MODE_EPHEMERAL = 'ephemeral';
export const SESSION_MODE_PERSISTENT = 'persistent';
export const SESSION_MODE_INACTIVITY = 'inactivity';
export const SESSION_MODE_NEVER = 'never';
export const SESSION_MODES = [
  SESSION_MODE_EPHEMERAL,
  SESSION_MODE_PERSISTENT,
  SESSION_MODE_INACTIVITY,
  SESSION_MODE_NEVER,
];

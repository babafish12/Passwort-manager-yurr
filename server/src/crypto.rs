use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use zeroize::Zeroizing;

use crate::config::{ARGON2_M_COST, ARGON2_P_COST, ARGON2_T_COST, DEFAULT_PASSWORD_LENGTH};

const UPPERCASE_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE_CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const DIGIT_CHARS: &[u8] = b"0123456789";
const SYMBOL_CHARS: &[u8] = b"!@#$%^&*()-_=+[]{}|;:,.<>?";

/// Hash the master password for authentication (stored in DB).
/// Uses Argon2id with a random salt.
pub fn hash_master_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(32))
            .expect("valid argon2 params"),
    );
    let hash = argon2.hash_password(password.as_bytes(), &salt)?;
    Ok(hash.to_string())
}

/// Verify the master password against the stored hash.
pub fn verify_master_password(password: &str, hash: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    let argon2 = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(32))
            .expect("valid argon2 params"),
    );
    argon2.verify_password(password.as_bytes(), &parsed).is_ok()
}

/// Derive a 256-bit encryption key from the master password using Argon2id.
/// The salt is stored separately from the auth hash salt.
pub fn derive_encryption_key(password: &str, salt: &[u8]) -> Zeroizing<[u8; 32]> {
    let argon2 = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, Some(32))
            .expect("valid argon2 params"),
    );
    let mut key = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .expect("key derivation failed");
    key
}

/// Generate a random encryption salt (16 bytes), returned as base64.
pub fn generate_encryption_salt() -> String {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    B64.encode(salt)
}

/// Encrypt plaintext with AES-256-GCM.
/// Returns base64(nonce[12] || ciphertext || tag[16]).
pub fn encrypt(plaintext: &str, key: &[u8; 32]) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init: {e}"))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("encryption failed: {e}"))?;

    // nonce || ciphertext (which includes the tag)
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    Ok(B64.encode(combined))
}

/// Decrypt base64(nonce[12] || ciphertext || tag[16]) with AES-256-GCM.
pub fn decrypt(encoded: &str, key: &[u8; 32]) -> Result<String, String> {
    let combined = B64
        .decode(encoded)
        .map_err(|e| format!("base64 decode: {e}"))?;
    if combined.len() < 12 + 16 {
        return Err("ciphertext too short".to_string());
    }

    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("cipher init: {e}"))?;

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("decryption failed: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("utf8 decode: {e}"))
}

/// Generate a random password with the given options.
pub fn generate_password(
    length: usize,
    uppercase: bool,
    lowercase: bool,
    digits: bool,
    symbols: bool,
) -> String {
    let requested_length = if length == 0 {
        DEFAULT_PASSWORD_LENGTH
    } else {
        length
    };

    let mut groups: Vec<&[u8]> = Vec::new();
    if uppercase {
        groups.push(UPPERCASE_CHARS);
    }
    if lowercase {
        groups.push(LOWERCASE_CHARS);
    }
    if digits {
        groups.push(DIGIT_CHARS);
    }
    if symbols {
        groups.push(SYMBOL_CHARS);
    }

    // Default to all character types if none selected
    if groups.is_empty() {
        groups.extend([UPPERCASE_CHARS, LOWERCASE_CHARS, DIGIT_CHARS, SYMBOL_CHARS]);
    }

    let length = requested_length.max(groups.len());
    let charset: Vec<u8> = groups
        .iter()
        .flat_map(|group| group.iter().copied())
        .collect();
    let mut password = Vec::with_capacity(length);
    let mut rng = OsRng;

    for group in &groups {
        password.push(group[random_index(group.len(), &mut rng)]);
    }

    while password.len() < length {
        password.push(charset[random_index(charset.len(), &mut rng)]);
    }

    for index in (1..password.len()).rev() {
        let swap_with = random_index(index + 1, &mut rng);
        password.swap(index, swap_with);
    }

    password.into_iter().map(char::from).collect()
}

fn random_index(len: usize, rng: &mut OsRng) -> usize {
    debug_assert!(len > 0);

    let len = len as u64;
    let zone = (u64::MAX / len) * len;

    loop {
        let value = rng.next_u64();
        if value < zone {
            return (value % len) as usize;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_and_verify_password() {
        let password = "my-super-secure-master-password!";
        let hash = hash_master_password(password).expect("hashing should work");
        assert!(verify_master_password(password, &hash));
        assert!(!verify_master_password("wrong-password", &hash));
    }

    #[test]
    fn test_encryption_roundtrip() {
        let password = "test-password";
        let salt = generate_encryption_salt();
        let salt_bytes = B64.decode(&salt).unwrap();
        let key = derive_encryption_key(password, &salt_bytes);

        let plaintext = "Hello, this is a secret!";
        let encrypted = encrypt(plaintext, &key).expect("encrypt should work");
        let decrypted = decrypt(&encrypted, &key).expect("decrypt should work");
        assert_eq!(plaintext, decrypted);
    }

    #[test]
    fn test_different_nonces_produce_different_ciphertexts() {
        let key = Zeroizing::new([42u8; 32]);
        let plaintext = "same message";
        let enc1 = encrypt(plaintext, &key).unwrap();
        let enc2 = encrypt(plaintext, &key).unwrap();
        assert_ne!(enc1, enc2); // Different nonces -> different output
    }

    #[test]
    fn test_decrypt_with_wrong_key_fails() {
        let key1 = Zeroizing::new([1u8; 32]);
        let key2 = Zeroizing::new([2u8; 32]);
        let encrypted = encrypt("secret", &key1).unwrap();
        assert!(decrypt(&encrypted, &key2).is_err());
    }

    #[test]
    fn test_password_generator_length() {
        let pw = generate_password(16, true, true, true, true);
        assert_eq!(pw.len(), 16);

        let pw = generate_password(32, true, true, true, true);
        assert_eq!(pw.len(), 32);
    }

    #[test]
    fn test_password_generator_only_digits() {
        let pw = generate_password(100, false, false, true, false);
        assert!(pw.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn test_password_generator_default_when_empty() {
        let pw = generate_password(0, false, false, false, false);
        assert_eq!(pw.len(), DEFAULT_PASSWORD_LENGTH);
    }

    #[test]
    fn test_password_generator_includes_selected_groups() {
        let pw = generate_password(32, true, true, true, true);
        assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
        assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
        assert!(pw.chars().any(|c| c.is_ascii_digit()));
        assert!(pw.chars().any(|c| SYMBOL_CHARS.contains(&(c as u8))));
    }

    #[test]
    fn test_password_generator_expands_too_short_lengths_to_fit_groups() {
        let pw = generate_password(2, true, true, true, true);
        assert_eq!(pw.len(), 4);
        assert!(pw.chars().any(|c| c.is_ascii_uppercase()));
        assert!(pw.chars().any(|c| c.is_ascii_lowercase()));
        assert!(pw.chars().any(|c| c.is_ascii_digit()));
        assert!(pw.chars().any(|c| SYMBOL_CHARS.contains(&(c as u8))));
    }
}

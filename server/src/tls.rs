use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use rcgen::{CertificateParams, KeyPair};
use tracing::info;

use crate::config::CERTS_DIR;

fn ensure_certs_dir() {
    fs::create_dir_all(CERTS_DIR).expect("Failed to create certs directory");

    #[cfg(unix)]
    fs::set_permissions(CERTS_DIR, fs::Permissions::from_mode(0o700))
        .expect("Failed to set secure certs directory permissions");
}

#[cfg(unix)]
fn set_file_mode(path: &str, mode: u32) {
    if Path::new(path).exists() {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .expect("Failed to set secure TLS file permissions");
    }
}

#[cfg(not(unix))]
fn set_file_mode(_path: &str, _mode: u32) {}

#[cfg(unix)]
fn write_file_with_mode(path: &str, contents: &str, mode: u32) {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
        .expect("Failed to write TLS file");
    file.write_all(contents.as_bytes())
        .expect("Failed to write TLS file");
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .expect("Failed to set secure TLS file permissions");
}

#[cfg(not(unix))]
fn write_file_with_mode(path: &str, contents: &str, _mode: u32) {
    fs::write(path, contents).expect("Failed to write TLS file");
}

pub fn ensure_certs() -> (String, String) {
    ensure_certs_dir();

    let cert_path = format!("{CERTS_DIR}/cert.pem");
    let key_path = format!("{CERTS_DIR}/key.pem");

    if Path::new(&cert_path).exists() && Path::new(&key_path).exists() {
        set_file_mode(&cert_path, 0o644);
        set_file_mode(&key_path, 0o600);

        info!("Using existing TLS certificates from {CERTS_DIR}/");
        let cert = fs::read_to_string(&cert_path).expect("Failed to read cert.pem");
        let key = fs::read_to_string(&key_path).expect("Failed to read key.pem");
        return (cert, key);
    }

    info!("Generating self-signed TLS certificate...");

    let mut params = CertificateParams::new(vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "0.0.0.0".to_string(),
    ])
    .expect("valid cert params");

    // Add SANs for LAN access
    params
        .subject_alt_names
        .push(rcgen::SanType::IpAddress(std::net::IpAddr::V4(
            std::net::Ipv4Addr::new(127, 0, 0, 1),
        )));
    params
        .subject_alt_names
        .push(rcgen::SanType::IpAddress(std::net::IpAddr::V4(
            std::net::Ipv4Addr::new(0, 0, 0, 0),
        )));

    let key_pair = KeyPair::generate().expect("Failed to generate key pair");
    let cert = params
        .self_signed(&key_pair)
        .expect("Failed to generate self-signed cert");

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();

    write_file_with_mode(&cert_path, &cert_pem, 0o644);
    write_file_with_mode(&key_path, &key_pem, 0o600);

    info!("TLS certificate generated and saved to {CERTS_DIR}/");
    (cert_pem, key_pem)
}

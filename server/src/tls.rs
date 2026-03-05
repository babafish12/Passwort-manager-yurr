use std::fs;
use std::path::Path;

use rcgen::{CertificateParams, KeyPair};
use tracing::info;

use crate::config::CERTS_DIR;

pub fn ensure_certs() -> (String, String) {
    let cert_path = format!("{CERTS_DIR}/cert.pem");
    let key_path = format!("{CERTS_DIR}/key.pem");

    if Path::new(&cert_path).exists() && Path::new(&key_path).exists() {
        info!("Using existing TLS certificates from {CERTS_DIR}/");
        let cert = fs::read_to_string(&cert_path).expect("Failed to read cert.pem");
        let key = fs::read_to_string(&key_path).expect("Failed to read key.pem");
        return (cert, key);
    }

    info!("Generating self-signed TLS certificate...");
    fs::create_dir_all(CERTS_DIR).expect("Failed to create certs directory");

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

    fs::write(&cert_path, &cert_pem).expect("Failed to write cert.pem");
    fs::write(&key_path, &key_pem).expect("Failed to write key.pem");

    info!("TLS certificate generated and saved to {CERTS_DIR}/");
    (cert_pem, key_pem)
}

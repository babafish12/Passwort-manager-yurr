use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use reqwest::{redirect::Policy, Url};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};
use tracing::warn;

use crate::config;
use crate::domain;
use crate::errors::AppError;
use crate::models::FaviconRow;
use crate::session::AuthenticatedSession;
use crate::AppState;

const MAX_FAVICON_BYTES: usize = 256 * 1024;
const MAX_HTML_BYTES: usize = 128 * 1024;
const MAX_REDIRECTS: usize = 3;
const MAX_DISCOVERED_ICONS: usize = 8;
const MAX_CONCURRENT_FETCHES: usize = 4;
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const USER_AGENT: &str = "Mozilla/5.0 (compatible; YurrrPasswordManager/0.1; +https://localhost)";

static NEGATIVE_FAVICON_CACHE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static FAVICON_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static FAVICON_FETCH_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();

fn negative_cache() -> &'static Mutex<HashMap<String, Instant>> {
    NEGATIVE_FAVICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn in_flight_fetches() -> &'static Mutex<HashSet<String>> {
    FAVICON_IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

fn fetch_semaphore() -> &'static Semaphore {
    FAVICON_FETCH_SEMAPHORE.get_or_init(|| Semaphore::new(MAX_CONCURRENT_FETCHES))
}

async fn is_negative_cached(domain: &str) -> bool {
    let mut cache = negative_cache().lock().await;
    match cache.get(domain).copied() {
        Some(expires_at) if expires_at > Instant::now() => true,
        Some(_) => {
            cache.remove(domain);
            false
        }
        None => false,
    }
}

async fn remember_negative(domain: &str) {
    let mut cache = negative_cache().lock().await;
    let now = Instant::now();
    cache.retain(|_, expires_at| *expires_at > now);
    cache.insert(domain.to_string(), now + NEGATIVE_CACHE_TTL);
}

async fn clear_negative(domain: &str) {
    negative_cache().lock().await.remove(domain);
}

async fn mark_fetch_started(domain: &str) -> bool {
    in_flight_fetches().lock().await.insert(domain.to_string())
}

async fn mark_fetch_finished(domain: &str) {
    in_flight_fetches().lock().await.remove(domain);
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .redirect(Policy::none())
        .no_proxy()
        .pool_max_idle_per_host(0)
        .user_agent(USER_AGENT)
}

async fn build_client_for_url(url: &Url) -> Option<reqwest::Client> {
    let host = normalized_url_host(url)?;
    let addrs = resolve_public_addrs(url).await?;
    let mut builder = client_builder();

    if host.parse::<IpAddr>().is_err() {
        builder = builder.resolve_to_addrs(&host, &addrs);
    }

    builder.build().ok()
}

fn normalized_url_host(url: &Url) -> Option<String> {
    url.host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        .filter(|host| !host.is_empty())
}

fn validate_url(url: Url, allowed_hosts: &HashSet<String>) -> Option<Url> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }

    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }

    let host = normalized_url_host(&url)?;
    if !allowed_hosts.contains(&host) {
        return None;
    }

    if let Some(port) = url.port() {
        let expected = match url.scheme() {
            "http" => 80,
            "https" => 443,
            _ => return None,
        };
        if port != expected {
            return None;
        }
    }

    Some(url)
}

async fn resolve_public_addrs(url: &Url) -> Option<Vec<SocketAddr>> {
    let host = normalized_url_host(url)?;
    let port = url.port_or_known_default()?;

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            warn!("Blocked favicon request to non-public IP {ip}");
            return None;
        }
        return Some(vec![SocketAddr::new(ip, port)]);
    }

    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .ok()?
        .collect();

    if addrs.is_empty() {
        return None;
    }

    if let Some(blocked) = addrs.iter().find(|addr| is_blocked_ip(addr.ip())) {
        warn!(
            "Blocked favicon request for {host}: DNS resolved to non-public IP {}",
            blocked.ip()
        );
        return None;
    }

    Some(addrs)
}

async fn domain_resolves_to_blocked_ip(domain: &str) -> bool {
    if let Ok(ip) = domain.parse::<IpAddr>() {
        return is_blocked_ip(ip);
    }

    tokio::net::lookup_host((domain, 443))
        .await
        .map(|mut addrs| addrs.any(|addr| is_blocked_ip(addr.ip())))
        .unwrap_or(false)
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_blocked_ipv4(ip),
        IpAddr::V6(ip) => is_blocked_ipv6(ip),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();

    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(ipv4) = ip.to_ipv4_mapped() {
        return is_blocked_ipv4(ipv4);
    }

    let segments = ip.segments();
    let first = segments[0];

    ip.is_unspecified()
        || ip.is_loopback()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
        || (first & 0xff00) == 0xff00
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
}

async fn send_with_redirects(
    start_url: Url,
    allowed_hosts: &HashSet<String>,
) -> Option<(reqwest::Response, Url)> {
    let mut current_url = validate_url(start_url, allowed_hosts)?;

    for redirect_count in 0..=MAX_REDIRECTS {
        let client = build_client_for_url(&current_url).await?;
        let resp = client.get(current_url.clone()).send().await.ok()?;

        if resp.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return None;
            }

            let location = resp.headers().get(header::LOCATION)?.to_str().ok()?;
            current_url = validate_url(current_url.join(location).ok()?, allowed_hosts)?;
            continue;
        }

        return Some((resp, current_url));
    }

    None
}

fn response_mime(resp: &reqwest::Response) -> Option<String> {
    resp.headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

async fn read_limited_body(mut resp: reqwest::Response, max_bytes: usize) -> Option<Vec<u8>> {
    if resp
        .content_length()
        .is_some_and(|len| len > max_bytes as u64)
    {
        return None;
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.ok()? {
        if bytes.len() + chunk.len() > max_bytes {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }

    Some(bytes)
}

fn looks_like_image(bytes: &[u8]) -> bool {
    let trimmed = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map(|index| &bytes[index..])
        .unwrap_or(bytes);

    trimmed.starts_with(b"\x00\x00\x01\x00")
        || trimmed.starts_with(b"\x89PNG\r\n\x1a\n")
        || trimmed.starts_with(b"\xff\xd8\xff")
        || trimmed.starts_with(b"GIF87a")
        || trimmed.starts_with(b"GIF89a")
        || trimmed.starts_with(b"<svg")
        || trimmed.starts_with(b"<SVG")
        || trimmed.starts_with(b"<?xml")
}

async fn fetch_image(url: Url, allowed_hosts: &HashSet<String>) -> Option<(Vec<u8>, String)> {
    let (resp, _) = send_with_redirects(url, allowed_hosts).await?;
    if !resp.status().is_success() {
        return None;
    }

    let mime = response_mime(&resp);
    let bytes = read_limited_body(resp, MAX_FAVICON_BYTES).await?;
    if bytes.is_empty() {
        return None;
    }

    if mime
        .as_deref()
        .is_some_and(|value| value.starts_with("image/"))
        || looks_like_image(&bytes)
    {
        return Some((bytes, mime.unwrap_or_else(|| "image/x-icon".to_string())));
    }

    None
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let attr_pattern = format!("{attr}=");
    let lower_tag = tag.to_ascii_lowercase();
    let start = lower_tag.find(&attr_pattern)? + attr_pattern.len();
    let rest = tag[start..].trim_start();
    let quote = rest.chars().next()?;

    if quote == '"' || quote == '\'' {
        let value_start = quote.len_utf8();
        let value_end = rest[value_start..].find(quote)? + value_start;
        Some(rest[value_start..value_end].to_string())
    } else {
        let value_end = rest
            .find(|c: char| c.is_ascii_whitespace() || c == '>')
            .unwrap_or(rest.len());
        Some(rest[..value_end].to_string())
    }
}

fn discover_icon_urls(base_url: &Url, html: &str, allowed_hosts: &HashSet<String>) -> Vec<Url> {
    let mut urls = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut search_from = 0;

    while let Some(relative_start) = lower[search_from..].find("<link") {
        let tag_start = search_from + relative_start;
        let Some(relative_end) = lower[tag_start..].find('>') else {
            break;
        };
        let tag_end = tag_start + relative_end + 1;
        let tag = &html[tag_start..tag_end];
        let lower_tag = &lower[tag_start..tag_end];

        if lower_tag.contains("rel=") && lower_tag.contains("icon") {
            if let Some(href) = extract_attr(tag, "href") {
                if let Ok(url) = base_url.join(&href) {
                    if let Some(url) = validate_url(url, allowed_hosts) {
                        urls.push(url);
                    }
                }
            }
        }

        search_from = tag_end;
        if urls.len() >= MAX_DISCOVERED_ICONS {
            break;
        }
    }

    urls
}

async fn discover_from_homepage(url: Url, allowed_hosts: &HashSet<String>) -> Vec<Url> {
    let Some((resp, final_url)) = send_with_redirects(url, allowed_hosts).await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }

    let content_type = response_mime(&resp).unwrap_or_default();
    if !content_type.is_empty()
        && !content_type.contains("text/html")
        && !content_type.contains("application/xhtml+xml")
    {
        return Vec::new();
    }

    let Some(bytes) = read_limited_body(resp, MAX_HTML_BYTES).await else {
        return Vec::new();
    };
    let html = String::from_utf8_lossy(&bytes);

    discover_icon_urls(&final_url, &html, allowed_hosts)
}

fn domain_variants(domain: &str) -> Vec<String> {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    let mut seen = HashSet::new();
    let mut variants = Vec::new();

    if domain.parse::<IpAddr>().is_ok() {
        variants.push(domain);
        return variants;
    }

    let bare_domain = domain.strip_prefix("www.").unwrap_or(&domain);
    for candidate in [
        domain.clone(),
        bare_domain.to_string(),
        format!("www.{bare_domain}"),
    ] {
        if seen.insert(candidate.clone()) {
            variants.push(candidate);
        }
    }

    variants
}

fn url_host_for_domain(domain: &str) -> String {
    if domain.parse::<Ipv6Addr>().is_ok() {
        format!("[{domain}]")
    } else {
        domain.to_string()
    }
}

/// Fetch a favicon for a domain. Tries declared icons from the site's HTML,
/// common favicon paths over HTTPS/HTTP, then Google's favicon service.
pub async fn fetch_favicon_for_domain(domain: &str) -> Option<(Vec<u8>, String)> {
    let domain = domain::normalize_domain(domain)?;
    if domain_resolves_to_blocked_ip(&domain).await {
        warn!("Blocked favicon fetch for {domain}: target resolves to non-public IP");
        return None;
    }

    let variants = domain_variants(&domain);
    let allowed_hosts: HashSet<String> = variants.iter().cloned().collect();
    let mut seen_urls = HashSet::new();

    for variant in &variants {
        let host = url_host_for_domain(variant);
        for scheme in ["https", "http"] {
            if let Ok(direct_url) = Url::parse(&format!("{scheme}://{host}/favicon.ico")) {
                if seen_urls.insert(direct_url.to_string()) {
                    if let Some(icon) = fetch_image(direct_url, &allowed_hosts).await {
                        return Some(icon);
                    }
                }
            }

            if let Ok(homepage) = Url::parse(&format!("{scheme}://{host}/")) {
                for url in discover_from_homepage(homepage, &allowed_hosts).await {
                    if seen_urls.insert(url.to_string()) {
                        if let Some(icon) = fetch_image(url, &allowed_hosts).await {
                            return Some(icon);
                        }
                    }
                }
            }
        }
    }

    let google_hosts = HashSet::from(["www.google.com".to_string()]);
    let google_url = Url::parse_with_params(
        "https://www.google.com/s2/favicons",
        [("domain", domain.as_str()), ("sz", "64")],
    )
    .ok()?;

    fetch_image(google_url, &google_hosts).await
}

async fn ensure_favicon_with_policy(pool: &SqlitePool, domain: &str, allow_external_fetch: bool) {
    let Some(domain) = domain::normalize_domain(domain) else {
        return;
    };

    if !allow_external_fetch {
        return;
    }

    if is_negative_cached(&domain).await {
        return;
    }

    let exists: Option<(String,)> = sqlx::query_as("SELECT domain FROM favicons WHERE domain = ?")
        .bind(&domain)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

    if exists.is_some() {
        clear_negative(&domain).await;
        return;
    }

    if !mark_fetch_started(&domain).await {
        return;
    }

    let Ok(_permit) = fetch_semaphore().try_acquire() else {
        warn!("Skipping favicon fetch for {domain}: concurrency limit reached");
        mark_fetch_finished(&domain).await;
        return;
    };

    match fetch_favicon_for_domain(&domain).await {
        Some((image_data, mime_type)) => {
            if let Err(e) = sqlx::query(
                "INSERT OR REPLACE INTO favicons (domain, image_data, mime_type) VALUES (?, ?, ?)",
            )
            .bind(&domain)
            .bind(&image_data)
            .bind(&mime_type)
            .execute(pool)
            .await
            {
                warn!("Failed to store favicon for {domain}: {e}");
            } else {
                clear_negative(&domain).await;
            }
        }
        None => {
            remember_negative(&domain).await;
            warn!("No favicon found for {domain}");
        }
    }

    mark_fetch_finished(&domain).await;
}

/// Check if a favicon already exists for a domain; if not, fetch and store it
/// when background third-party favicon discovery is enabled.
pub async fn ensure_favicon(pool: &SqlitePool, domain: &str) {
    ensure_favicon_with_policy(pool, domain, config::third_party_favicons_enabled()).await;
}

/// GET /api/v1/favicons/{domain} — serve a cached favicon, fetching it on demand only when enabled.
pub async fn get_favicon_handler(
    State(state): State<AppState>,
    _session: AuthenticatedSession,
    Path(domain): Path<String>,
) -> Result<Response, AppError> {
    let domain = domain::normalize_domain(&domain)
        .ok_or_else(|| AppError::BadRequest("Invalid favicon domain".into()))?;

    let mut favicon: Option<FaviconRow> =
        sqlx::query_as("SELECT image_data, mime_type FROM favicons WHERE domain = ?")
            .bind(&domain)
            .fetch_optional(&state.db)
            .await?;

    if favicon.is_none() && config::third_party_favicons_enabled() {
        ensure_favicon_with_policy(&state.db, &domain, true).await;
        favicon = sqlx::query_as("SELECT image_data, mime_type FROM favicons WHERE domain = ?")
            .bind(&domain)
            .fetch_optional(&state.db)
            .await?;
    }

    match favicon {
        Some(row) => {
            let response = (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, row.mime_type),
                    (header::CACHE_CONTROL, "public, max-age=86400".to_string()),
                ],
                row.image_data,
            );
            Ok(response.into_response())
        }
        None => Err(AppError::NotFound("Favicon not found".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_non_public_ip_ranges() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))));
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_blocked_ip(IpAddr::V6("fe80::1".parse().unwrap())));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))));
    }

    #[test]
    fn discovery_rejects_cross_host_absolute_icon_urls() {
        let base_url = Url::parse("https://example.com/").unwrap();
        let allowed_hosts = HashSet::from(["example.com".to_string()]);
        let html = r#"
            <link rel="icon" href="https://attacker.test/favicon.ico">
            <link rel="shortcut icon" href="/favicon.ico">
        "#;

        let urls = discover_icon_urls(&base_url, html, &allowed_hosts);

        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].as_str(), "https://example.com/favicon.ico");
    }
}

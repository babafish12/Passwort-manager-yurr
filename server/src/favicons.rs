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
const MAX_MANIFEST_BYTES: usize = 128 * 1024;
const MAX_REDIRECTS: usize = 3;
const MAX_DISCOVERED_ICONS: usize = 8;
const MAX_DISCOVERED_MANIFESTS: usize = 2;
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct IconCandidate {
    url: Url,
    source: IconSource,
    sizes: Vec<IconSize>,
    type_hint: Option<String>,
    order: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IconSource {
    HtmlIcon,
    AppleTouch,
    Manifest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IconSize {
    Any,
    Px { width: u32, height: u32 },
}

#[derive(Debug, Default)]
struct HtmlIconDiscovery {
    icons: Vec<IconCandidate>,
    manifests: Vec<Url>,
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x00\x00\x01\x00") {
        return Some("image/x-icon");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if is_avif(bytes) {
        return Some("image/avif");
    }
    if looks_like_svg(bytes) {
        return Some("image/svg+xml");
    }

    None
}

fn is_avif(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && bytes[8..]
            .windows(4)
            .any(|brand| brand == b"avif" || brand == b"avis")
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let trimmed = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map(|index| &bytes[index..])
        .unwrap_or(bytes);

    let trimmed = trimmed.strip_prefix(b"\xef\xbb\xbf").unwrap_or(trimmed);
    let prefix_len = trimmed.len().min(1024);
    let Ok(prefix) = std::str::from_utf8(&trimmed[..prefix_len]) else {
        return false;
    };
    let lower = prefix.to_ascii_lowercase();

    lower.starts_with("<svg")
        || ((lower.starts_with("<?xml")
            || lower.starts_with("<!--")
            || lower.starts_with("<!doctype svg"))
            && lower.contains("<svg"))
}

async fn fetch_image(url: Url, allowed_hosts: &HashSet<String>) -> Option<(Vec<u8>, String)> {
    let (resp, _) = send_with_redirects(url, allowed_hosts).await?;
    if !resp.status().is_success() {
        return None;
    }

    let bytes = read_limited_body(resp, MAX_FAVICON_BYTES).await?;
    if bytes.is_empty() {
        return None;
    }

    detect_image_mime(&bytes).map(|mime| (bytes, mime.to_string()))
}

fn parse_link_attrs(tag: &str) -> HashMap<String, String> {
    let bytes = tag.as_bytes();
    let mut attrs = HashMap::new();
    let mut index = 0;

    while index < bytes.len() {
        while index < bytes.len()
            && !bytes[index].is_ascii_alphanumeric()
            && !matches!(bytes[index], b'_' | b'-' | b':')
        {
            index += 1;
        }

        if index >= bytes.len() || bytes[index] == b'>' {
            break;
        }

        let name_start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'-' | b':'))
        {
            index += 1;
        }

        if name_start == index {
            index += 1;
            continue;
        }

        let name = tag[name_start..index].to_ascii_lowercase();

        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }

        if index >= bytes.len() || bytes[index] != b'=' {
            attrs.insert(name, String::new());
            continue;
        }

        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }

        if index >= bytes.len() {
            attrs.insert(name, String::new());
            break;
        }

        let value;
        if matches!(bytes[index], b'"' | b'\'') {
            let quote = bytes[index];
            index += 1;
            let value_start = index;
            while index < bytes.len() && bytes[index] != quote {
                index += 1;
            }
            value = tag[value_start..index].to_string();
            if index < bytes.len() {
                index += 1;
            }
        } else {
            let value_start = index;
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'>'
            {
                index += 1;
            }
            value = tag[value_start..index].to_string();
        }

        attrs.insert(name, value);
    }

    attrs.remove("link");
    attrs
}

fn rel_tokens(rel: &str) -> impl Iterator<Item = String> + '_ {
    rel.split_ascii_whitespace()
        .map(|token| token.to_ascii_lowercase())
}

fn has_rel_token(rel: &str, token: &str) -> bool {
    rel_tokens(rel).any(|rel_token| rel_token == token)
}

fn is_icon_rel(rel: &str) -> bool {
    has_rel_token(rel, "icon")
        || has_rel_token(rel, "apple-touch-icon")
        || has_rel_token(rel, "apple-touch-icon-precomposed")
}

fn is_apple_touch_rel(rel: &str) -> bool {
    has_rel_token(rel, "apple-touch-icon") || has_rel_token(rel, "apple-touch-icon-precomposed")
}

fn normalized_type_hint(value: &str) -> Option<String> {
    value
        .split(';')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn parse_icon_sizes(sizes: Option<&str>) -> Vec<IconSize> {
    let Some(sizes) = sizes else {
        return Vec::new();
    };

    sizes
        .split_ascii_whitespace()
        .filter_map(|size| {
            if size.eq_ignore_ascii_case("any") {
                return Some(IconSize::Any);
            }

            let (width, height) = size.split_once(['x', 'X'])?;
            let width = width.parse::<u32>().ok()?;
            let height = height.parse::<u32>().ok()?;
            if width == 0 || height == 0 || width > 4096 || height > 4096 {
                return None;
            }

            Some(IconSize::Px { width, height })
        })
        .collect()
}

fn parse_html_icon_links(
    base_url: &Url,
    html: &str,
    allowed_hosts: &HashSet<String>,
) -> HtmlIconDiscovery {
    let mut discovery = HtmlIconDiscovery::default();
    let lower = html.to_ascii_lowercase();
    let mut search_from = 0;
    let mut order = 0;

    while let Some(relative_start) = lower[search_from..].find("<link") {
        let tag_start = search_from + relative_start;
        let Some(relative_end) = lower[tag_start..].find('>') else {
            break;
        };
        let tag_end = tag_start + relative_end + 1;
        let tag = &html[tag_start..tag_end];
        let attrs = parse_link_attrs(tag);

        if let (Some(rel), Some(href)) = (attrs.get("rel"), attrs.get("href")) {
            if is_icon_rel(rel) {
                if let Ok(url) = base_url.join(href) {
                    if let Some(url) = validate_url(url, allowed_hosts) {
                        let source = if is_apple_touch_rel(rel) {
                            IconSource::AppleTouch
                        } else {
                            IconSource::HtmlIcon
                        };
                        discovery.icons.push(IconCandidate {
                            url,
                            source,
                            sizes: parse_icon_sizes(attrs.get("sizes").map(String::as_str)),
                            type_hint: attrs
                                .get("type")
                                .and_then(|value| normalized_type_hint(value)),
                            order,
                        });
                    }
                }
            }

            if has_rel_token(rel, "manifest") {
                if let Ok(url) = base_url.join(href) {
                    if let Some(url) = validate_url(url, allowed_hosts) {
                        discovery.manifests.push(url);
                    }
                }
            }
        }

        search_from = tag_end;
        order += 1;
    }

    discovery
}

fn parse_manifest_icon_candidates(
    manifest_url: &Url,
    manifest: &str,
    allowed_hosts: &HashSet<String>,
    order_start: usize,
) -> Vec<IconCandidate> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(manifest) else {
        return Vec::new();
    };
    let Some(icons) = value.get("icons").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };

    icons
        .iter()
        .enumerate()
        .filter_map(|(index, icon)| {
            let src = icon.get("src")?.as_str()?.trim();
            if src.is_empty() {
                return None;
            }

            let url = validate_url(manifest_url.join(src).ok()?, allowed_hosts)?;
            Some(IconCandidate {
                url,
                source: IconSource::Manifest,
                sizes: parse_icon_sizes(icon.get("sizes").and_then(serde_json::Value::as_str)),
                type_hint: icon
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .and_then(normalized_type_hint),
                order: order_start + index,
            })
        })
        .collect()
}

fn icon_candidate_score(candidate: &IconCandidate) -> u32 {
    icon_size_score(&candidate.sizes)
        + source_score(candidate.source)
        + type_hint_score(candidate.type_hint.as_deref())
}

fn icon_size_score(sizes: &[IconSize]) -> u32 {
    if sizes.iter().any(|size| matches!(size, IconSize::Any)) {
        return 0;
    }

    sizes
        .iter()
        .filter_map(|size| match *size {
            IconSize::Any => None,
            IconSize::Px { width, height } => {
                let side = width.max(height);
                let shape_penalty = width.abs_diff(height) * 2;
                let size_penalty = if side >= 64 {
                    side - 64
                } else {
                    (64 - side) * 4
                };
                Some(shape_penalty + size_penalty)
            }
        })
        .min()
        .unwrap_or(80)
}

fn source_score(source: IconSource) -> u32 {
    match source {
        IconSource::HtmlIcon => 0,
        IconSource::Manifest => 5,
        IconSource::AppleTouch => 20,
    }
}

fn type_hint_score(type_hint: Option<&str>) -> u32 {
    match type_hint {
        Some("image/svg+xml") => 0,
        Some("image/png" | "image/webp" | "image/avif") => 2,
        Some("image/jpeg" | "image/gif" | "image/bmp") => 8,
        Some("image/x-icon" | "image/vnd.microsoft.icon") => 12,
        Some(value) if value.starts_with("image/") => 15,
        Some(_) => 30,
        None => 10,
    }
}

fn sort_and_limit_icon_candidates(candidates: Vec<IconCandidate>) -> Vec<IconCandidate> {
    let mut by_url: HashMap<String, IconCandidate> = HashMap::new();

    for candidate in candidates {
        let key = candidate.url.as_str().to_string();
        match by_url.get(&key) {
            Some(existing)
                if (icon_candidate_score(existing), existing.order)
                    <= (icon_candidate_score(&candidate), candidate.order) => {}
            _ => {
                by_url.insert(key, candidate);
            }
        }
    }

    let mut candidates: Vec<IconCandidate> = by_url.into_values().collect();
    candidates.sort_by_key(|candidate| (icon_candidate_score(candidate), candidate.order));
    candidates.truncate(MAX_DISCOVERED_ICONS);
    candidates
}

#[cfg(test)]
fn discover_icon_urls(base_url: &Url, html: &str, allowed_hosts: &HashSet<String>) -> Vec<Url> {
    sort_and_limit_icon_candidates(parse_html_icon_links(base_url, html, allowed_hosts).icons)
        .into_iter()
        .map(|candidate| candidate.url)
        .collect()
}

async fn discover_from_manifest(
    manifest_url: Url,
    allowed_hosts: &HashSet<String>,
    order_start: usize,
) -> Vec<IconCandidate> {
    let Some((resp, final_url)) = send_with_redirects(manifest_url, allowed_hosts).await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }

    let content_type = response_mime(&resp).unwrap_or_default();
    if !content_type.is_empty()
        && !content_type.contains("json")
        && !content_type.contains("manifest")
        && !content_type.contains("text/plain")
    {
        return Vec::new();
    }

    let Some(bytes) = read_limited_body(resp, MAX_MANIFEST_BYTES).await else {
        return Vec::new();
    };
    let manifest = String::from_utf8_lossy(&bytes);

    parse_manifest_icon_candidates(&final_url, &manifest, allowed_hosts, order_start)
}

async fn discover_from_homepage(url: Url, allowed_hosts: &HashSet<String>) -> Vec<IconCandidate> {
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

    let mut discovery = parse_html_icon_links(&final_url, &html, allowed_hosts);
    let mut candidates = Vec::new();
    candidates.append(&mut discovery.icons);

    let mut seen_manifests = HashSet::new();
    let manifest_order_start = candidates.len() + discovery.manifests.len();
    for (index, manifest_url) in discovery.manifests.into_iter().enumerate() {
        if index >= MAX_DISCOVERED_MANIFESTS {
            break;
        }
        if seen_manifests.insert(manifest_url.to_string()) {
            candidates.extend(
                discover_from_manifest(manifest_url, allowed_hosts, manifest_order_start + index)
                    .await,
            );
        }
    }

    sort_and_limit_icon_candidates(candidates)
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
            if let Ok(homepage) = Url::parse(&format!("{scheme}://{host}/")) {
                for candidate in discover_from_homepage(homepage, &allowed_hosts).await {
                    let url = candidate.url;
                    if seen_urls.insert(url.to_string()) {
                        if let Some(icon) = fetch_image(url, &allowed_hosts).await {
                            return Some(icon);
                        }
                    }
                }
            }
        }
    }

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
            <link rel = "icon" href = "https://attacker.test/favicon.ico">
            <link href = "/favicon.ico" rel = "shortcut icon">
        "#;

        let urls = discover_icon_urls(&base_url, html, &allowed_hosts);

        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].as_str(), "https://example.com/favicon.ico");
    }

    #[test]
    fn discovery_supports_spaced_attrs_apple_icons_and_64px_scoring() {
        let base_url = Url::parse("https://example.com/").unwrap();
        let allowed_hosts = HashSet::from(["example.com".to_string()]);
        let html = r#"
            <LINK href = "/icon-16.png" rel = "shortcut icon" sizes = "16x16" type = "image/png">
            <link rel = "apple-touch-icon-precomposed" href = "/apple.png" sizes = "180x180">
            <link sizes = "64x64" type = "image/png" rel = "icon" href = "/icon-64.png">
        "#;

        let urls = discover_icon_urls(&base_url, html, &allowed_hosts);

        assert_eq!(urls.len(), 3);
        assert_eq!(urls[0].as_str(), "https://example.com/icon-64.png");
        assert_eq!(urls[1].as_str(), "https://example.com/apple.png");
        assert_eq!(urls[2].as_str(), "https://example.com/icon-16.png");
    }

    #[test]
    fn html_discovery_parses_manifest_links_without_mixing_them_with_icons() {
        let base_url = Url::parse("https://example.com/settings/").unwrap();
        let allowed_hosts = HashSet::from(["example.com".to_string()]);
        let html = r#"
            <link rel = "manifest" href = "/site.webmanifest">
            <link rel = "manifest" href = "https://cdn.example.test/app.webmanifest">
            <link rel = "icon" href = "/icon.svg" sizes = "any" type = "image/svg+xml">
        "#;

        let discovery = parse_html_icon_links(&base_url, html, &allowed_hosts);

        assert_eq!(discovery.icons.len(), 1);
        assert_eq!(
            discovery.icons[0].url.as_str(),
            "https://example.com/icon.svg"
        );
        assert_eq!(discovery.manifests.len(), 1);
        assert_eq!(
            discovery.manifests[0].as_str(),
            "https://example.com/site.webmanifest"
        );
    }

    #[test]
    fn manifest_parser_extracts_same_host_icons_and_scores_64px_first() {
        let manifest_url = Url::parse("https://example.com/app/site.webmanifest").unwrap();
        let allowed_hosts = HashSet::from(["example.com".to_string()]);
        let manifest = r#"
            {
                "icons": [
                    {"src": "icon-32.png", "sizes": "32x32", "type": "image/png"},
                    {"src": "https://attacker.test/icon-64.png", "sizes": "64x64", "type": "image/png"},
                    {"src": "/icon-128.png", "sizes": "128x128", "type": "image/png"},
                    {"src": "/icon-64.png", "sizes": "64x64", "type": "image/png"}
                ]
            }
        "#;

        let candidates = sort_and_limit_icon_candidates(parse_manifest_icon_candidates(
            &manifest_url,
            manifest,
            &allowed_hosts,
            0,
        ));

        assert_eq!(candidates.len(), 3);
        assert_eq!(
            candidates[0].url.as_str(),
            "https://example.com/icon-64.png"
        );
        assert_eq!(
            candidates[1].url.as_str(),
            "https://example.com/icon-128.png"
        );
        assert_eq!(
            candidates[2].url.as_str(),
            "https://example.com/app/icon-32.png"
        );
    }

    #[test]
    fn detects_favicon_mime_from_bytes() {
        assert_eq!(
            detect_image_mime(b"\x00\x00\x01\x00\x01\x00"),
            Some("image/x-icon")
        );
        assert_eq!(
            detect_image_mime(b"\x89PNG\r\n\x1a\n\x00\x00"),
            Some("image/png")
        );
        assert_eq!(
            detect_image_mime(
                br#"  <?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>"#
            ),
            Some("image/svg+xml")
        );
        assert_eq!(
            detect_image_mime(br#"<html><body><svg></svg></body></html>"#),
            None
        );
    }
}

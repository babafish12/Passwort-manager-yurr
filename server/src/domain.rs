use std::net::IpAddr;
use url::Url;

fn normalized_host(url: &Url) -> Option<String> {
    url.host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        .filter(|host| !host.is_empty())
}

pub fn normalize_domain(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    Url::parse(&with_scheme)
        .ok()
        .and_then(|url| normalized_host(&url))
}

pub fn normalize_entry_domain(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some((_, authority_and_path)) = trimmed.split_once("://") {
        if authority_and_path.is_empty() || authority_and_path.starts_with('/') {
            return None;
        }
    }

    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    let url = Url::parse(&with_scheme).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }

    normalized_host(&url)
}

pub fn normalize_domain_lossy(input: &str) -> String {
    normalize_domain(input).unwrap_or_else(|| {
        input
            .trim()
            .trim_end_matches('/')
            .trim_end_matches('.')
            .to_ascii_lowercase()
    })
}

pub fn is_local_host(host: &str) -> bool {
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let octets = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        Ok(IpAddr::V6(ip)) => {
            if let Some(ipv4) = ip.to_ipv4_mapped() {
                return is_local_host(&ipv4.to_string());
            }
            let first = ip.segments()[0];
            ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

/// Private hosts can run independent vault accounts on each TCP port.
/// Derive the scope from the saved URL so existing entries need no migration.
pub fn credential_scope(input: &str) -> Option<String> {
    let input = input.trim();
    let host = normalize_entry_domain(input)?;
    if !is_local_host(&host) {
        return Some(host);
    }
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&with_scheme).ok()?;
    Some(format!("{host}:{}", url.port_or_known_default()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_port_scopes_match_extension_behavior() {
        let cases: Vec<(String, Option<String>)> =
            serde_json::from_str(include_str!("../../tests/site-scope-cases.json")).unwrap();
        for (url, expected) in cases {
            assert_eq!(credential_scope(&url), expected, "{url}");
        }
    }

    #[test]
    fn normalizes_urls_and_bare_domains() {
        assert_eq!(
            normalize_domain("https://WWW.Example.COM/login").as_deref(),
            Some("www.example.com")
        );
        assert_eq!(
            normalize_domain("example.com/path").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            normalize_domain("example.com.").as_deref(),
            Some("example.com")
        );
    }

    #[test]
    fn returns_none_for_empty_input() {
        assert_eq!(normalize_domain("   "), None);
    }

    #[test]
    fn validates_entry_domains_for_http_https_or_bare_domains() {
        assert_eq!(
            normalize_entry_domain("https://WWW.Example.COM/login").as_deref(),
            Some("www.example.com")
        );
        assert_eq!(
            normalize_entry_domain("example.com/path").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            normalize_entry_domain("http://localhost:8080").as_deref(),
            Some("localhost")
        );
    }

    #[test]
    fn rejects_invalid_entry_domains() {
        assert_eq!(normalize_entry_domain(""), None);
        assert_eq!(normalize_entry_domain("not a url"), None);
        assert_eq!(normalize_entry_domain("ftp://example.com"), None);
        assert_eq!(
            normalize_entry_domain("https://user:pass@example.com"),
            None
        );
        assert_eq!(normalize_entry_domain("https:///missing-host"), None);
    }
}

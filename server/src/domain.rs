use url::Url;

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
        .and_then(|url| {
            url.host_str()
                .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        })
        .filter(|host| !host.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;

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
}

//! A store's public contact details -- what customers tap to email or visit
//! it. Every app turns them into links (`mailto:`, a website), so validation
//! holds them to forms that can only ever be those: an email address of
//! plain characters -- none that a `mailto:` link reads as more than the
//! address (`?cc=`, `%`) -- and a web address with a real host and nothing
//! in front of it. The app's forms apply the same rules
//! (`web/src/lib/menu/contact.ts`), and its links check them again.
//!
//! Both may be empty: a store needn't give either.

use crate::limits::{MAX_EMAIL_CHARS, MAX_WEBSITE_CHARS};

/// A domain name: two or more labels of letters, digits and inner hyphens,
/// the last all letters.
fn is_domain(domain: &str) -> bool {
    let labels: Vec<&str> = domain.split('.').collect();
    let label_ok = |l: &&str| !l.is_empty() && l.len() <= 63 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !l.starts_with('-') && !l.ends_with('-');
    labels.len() >= 2 && labels.iter().all(label_ok) && labels.last().is_some_and(|tld| tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_alphabetic()))
}

/// Why `email` isn't an email address a store can give, if it isn't.
pub fn email_problem(email: &str) -> Option<String> {
    if email.is_empty() {
        return None;
    }
    if email.chars().count() > MAX_EMAIL_CHARS {
        return Some(format!("email may be at most {MAX_EMAIL_CHARS} characters"));
    }
    let local_ok = |l: &str| !l.is_empty() && l.len() <= 64 && !l.starts_with('.') && !l.ends_with('.') && !l.contains("..") && l.bytes().all(|b| b.is_ascii_alphanumeric() || b"._+-'".contains(&b));
    match email.split_once('@') {
        Some((local, domain)) if local_ok(local) && is_domain(domain) => None,
        _ => Some("email must be an address like name@example.com".into()),
    }
}

/// Why `website` isn't a web address a store can give, if it isn't: it must
/// be `http(s)://` and a host -- with no `user@` before it, which could
/// dress one site up as another -- then, optionally, a path of printable
/// characters that can't break out of a link.
pub fn website_problem(website: &str) -> Option<String> {
    if website.is_empty() {
        return None;
    }
    if website.chars().count() > MAX_WEBSITE_CHARS {
        return Some(format!("website may be at most {MAX_WEBSITE_CHARS} characters"));
    }
    let invalid = || Some("website must be a web address like https://example.com".into());
    let Some(rest) = website.strip_prefix("https://").or_else(|| website.strip_prefix("http://")) else { return invalid() };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(end);
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.bytes().all(|b| b.is_ascii_digit()) && port.parse::<u16>().is_ok_and(|p| p > 0) => host,
        Some(_) => return invalid(),
        None => authority,
    };
    let path_ok = path.bytes().all(|b| b.is_ascii_graphic() && !b"<>\"'`\\{}|^".contains(&b));
    if is_domain(&host.to_ascii_lowercase()) && path_ok { None } else { invalid() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_addresses_pass() {
        for ok in ["", "hi@mos.com", "first.last+orders@mail.example.co.uk", "o'brien@pub.ie"] {
            assert_eq!(email_problem(ok), None, "{ok}");
        }
        for ok in ["", "https://mos.com", "http://mos.com/menu?day=fri#lunch", "https://Mos-Diner.example.org:8443/a/b", "https://xn--caf-dma.fr"] {
            assert_eq!(website_problem(ok), None, "{ok}");
        }
    }

    #[test]
    fn nothing_that_could_be_anything_but_an_address() {
        for bad in ["mos", "@mos.com", "hi@", "hi@mos", "hi@@mos.com", "a@b@mos.com", "hi there@mos.com", "hi@mos.com?subject=x", "a?cc=them@mos.com", "a%3Fcc@mos.com", "a&b@mos.com", "hi@mos.com\n", "<hi@mos.com>", "hi@-mos.com", "hi@mos.c0m", ".hi@mos.com", "hi..x@mos.com", "hi@mos..com"] {
            assert!(email_problem(bad).is_some(), "{bad:?}");
        }
        assert!(email_problem(&format!("{}@mos.com", "a".repeat(250))).is_some());
    }

    #[test]
    fn nothing_that_could_be_anything_but_a_web_page() {
        for bad in [
            "mos.com", "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "ftp://mos.com", "https://", "https://mos", "https://good.com@evil.com", "https://user:pw@mos.com",
            "https://mos.com/\"onmouseover=\"x", "https://mos.com/<script>", "https://mos.com/a b", "https://mos.com:99999", "https://mos.com:", "https://mos.com\n", "https://-mos.com", " https://mos.com",
        ] {
            assert!(website_problem(bad).is_some(), "{bad:?}");
        }
        assert!(website_problem(&format!("https://mos.com/{}", "a".repeat(200))).is_some());
    }
}

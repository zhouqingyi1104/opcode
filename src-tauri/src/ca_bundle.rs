//! NODE_EXTRA_CA_CERTS sanitiser.
//!
//! Windows' root store still contains 1990s roots self-signed with MD2 or MD5.
//! Modern TLS stacks (the OpenSSL 3 that Node and Claude Code ship) refuse to
//! verify those signatures, so a bundle that includes one makes every Claude
//! Code start print:
//!
//!   Claude Code ignored the certificate with SHA-256 fingerprint ...: it names
//!   itself as its issuer, but Claude Code could not confirm that the
//!   certificate's own key signed it
//!
//! The certificate really is useless (nothing has chained to a 1996 MD2 root in
//! decades), but the warning looks alarming. Instead of disabling the check
//! globally via CLAUDE_CODE_DISABLE_SELF_NAMED_CERT_DROP, we hand the child a
//! copy of the bundle with just those legacy roots removed.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
const END: &str = "-----END CERTIFICATE-----";

/// RSA signature OIDs that no current TLS stack will verify.
/// md2WithRSAEncryption (1.2.840.113549.1.1.2) and md5WithRSAEncryption (…1.1.4).
/// DER layout: tag 0x06, length 0x09, then the 9 content bytes.
const LEGACY_SIG_OIDS: [&[u8]; 2] = [
    &[0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x02],
    &[0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x04],
];

fn is_legacy(block: &str) -> bool {
    let body: String = block
        .replace(BEGIN, "")
        .replace(END, "")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();

    let Ok(der) = STANDARD.decode(body.as_bytes()) else {
        return false; // unparseable: leave it alone
    };

    LEGACY_SIG_OIDS
        .iter()
        .any(|oid| der.windows(oid.len()).any(|window| window == *oid))
}

/// Removes certificate blocks signed with MD2/MD5.
///
/// Returns the filtered PEM and how many blocks were dropped. Everything that is
/// not a certificate block (comments, blank lines) is preserved as-is.
pub fn strip_legacy_roots(pem: &str) -> (String, usize) {
    let mut out = String::with_capacity(pem.len());
    let mut dropped = 0;
    let mut rest = pem;

    while let Some(start) = rest.find(BEGIN) {
        let (before, tail) = rest.split_at(start);
        out.push_str(before);

        let Some(end_offset) = tail.find(END) else {
            // Malformed tail: keep whatever is left untouched.
            out.push_str(tail);
            return (out, dropped);
        };

        let block = &tail[..end_offset + END.len()];
        if is_legacy(block) {
            dropped += 1;
        } else {
            out.push_str(block);
        }

        rest = &tail[end_offset + END.len()..];
    }

    out.push_str(rest);
    (out, dropped)
}

/// Path to a sanitised copy of the configured CA bundle, if filtering was needed.
/// Cached: the bundle is written at most once per process.
pub fn sanitized_bundle_path() -> Option<&'static PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();

    CACHE
        .get_or_init(|| {
            let configured = std::env::var_os("NODE_EXTRA_CA_CERTS")?;
            let source = PathBuf::from(configured);
            let pem = fs::read_to_string(&source).ok()?;

            let (filtered, dropped) = strip_legacy_roots(&pem);
            if dropped == 0 {
                return None;
            }

            let target = std::env::temp_dir()
                .join(format!("claude-ca-bundle-{}.pem", std::process::id()));
            fs::write(&target, filtered).ok()?;

            log::info!(
                "Filtered {} legacy CA certificate(s) out of NODE_EXTRA_CA_CERTS ({} -> {})",
                dropped,
                source.display(),
                target.display()
            );
            Some(target)
        })
        .as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal PEM block wrapping arbitrary DER bytes.
    fn block(der: &[u8]) -> String {
        format!(
            "{}\n{}\n{}\n",
            BEGIN,
            STANDARD.encode(der),
            END
        )
    }

    fn modern_der() -> Vec<u8> {
        // sha256WithRSAEncryption 1.2.840.113549.1.1.11
        let mut v = vec![0x30, 0x0F, 0x06, 0x09];
        v.extend_from_slice(&[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B]);
        v.extend_from_slice(&[0x05, 0x00, 0xAA, 0xBB]);
        v
    }

    fn md2_der() -> Vec<u8> {
        let mut v = vec![0x30, 0x0F];
        v.extend_from_slice(LEGACY_SIG_OIDS[0]);
        v.extend_from_slice(&[0x05, 0x00, 0xCC, 0xDD]);
        v
    }

    #[test]
    fn drops_md2_but_keeps_modern() {
        let pem = format!("{}{}", block(&md2_der()), block(&modern_der()));
        let (out, dropped) = strip_legacy_roots(&pem);

        assert_eq!(dropped, 1);
        assert_eq!(out.matches(BEGIN).count(), 1);
        assert!(out.contains(&STANDARD.encode(modern_der())));
        assert!(!out.contains(&STANDARD.encode(md2_der())));
    }

    #[test]
    fn leaves_clean_bundles_untouched() {
        let pem = format!("{}{}", block(&modern_der()), block(&modern_der()));
        let (out, dropped) = strip_legacy_roots(&pem);

        assert_eq!(dropped, 0);
        assert_eq!(out, pem);
    }

    #[test]
    fn preserves_leading_comments_and_blank_lines() {
        let pem = format!(
            "# generated bundle\n\n{}{}\n",
            block(&modern_der()),
            block(&md2_der())
        );
        let (out, dropped) = strip_legacy_roots(&pem);

        assert_eq!(dropped, 1);
        assert!(out.starts_with("# generated bundle\n\n"));
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn keeps_malformed_tail() {
        let pem = format!("{}{}", block(&modern_der()), "-----BEGIN CERTIFICATE-----\nbroken");
        let (out, dropped) = strip_legacy_roots(&pem);

        assert_eq!(dropped, 0);
        assert!(out.contains("broken"));
    }

    /// Reads the machine's real bundle. Run with:
    /// cargo test --lib real_bundle -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_bundle_filtering() {
        let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS") else {
            println!("[real] NODE_EXTRA_CA_CERTS not set, skipping");
            return;
        };
        let pem = fs::read_to_string(&path).expect("readable bundle");
        let before = pem.matches(BEGIN).count();
        let (out, dropped) = strip_legacy_roots(&pem);
        let after = out.matches(BEGIN).count();
        println!("[real] certs {} -> {} (dropped {})", before, after, dropped);
        assert_eq!(before - after, dropped);

        if let Some(path) = sanitized_bundle_path() {
            println!("[real] sanitized bundle written to: {}", path.display());
        } else {
            println!("[real] nothing to filter");
        }
    }
}

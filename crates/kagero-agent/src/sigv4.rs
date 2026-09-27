//! AWS Signature Version 4 signing for the Secrets Manager call at /run.
//! Self-contained (sha2/hmac/hex only) so the agent stays a small static
//! binary without the aws-sdk stack.

use anyhow::Result;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

// Redact keys so an accidental `{:?}` cannot leak them into logs.
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("access_key_id", &"REDACTED")
            .field("secret_access_key", &"REDACTED")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "REDACTED"),
            )
            .finish()
    }
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '~')
            || (keep_slash && c == '/')
        {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Everything needed to build the canonical request and string-to-sign,
/// apart from credentials, service, and region.
pub struct SignInput<'a> {
    pub method: &'a str,
    pub canonical_uri: &'a str,
    pub canonical_query: &'a str,
    pub signed_headers: &'a [(String, String)],
    pub payload: &'a [u8],
    /// "YYYYMMDD'T'HHMMSS'Z'"
    pub amz_date: &'a str,
    /// "YYYYMMDD"
    pub date: &'a str,
}

/// Sign a request and return the `Authorization` header value.
/// `signed_headers` must contain every header that will be sent and
/// signed (host is added by the caller; `x-amz-security-token` when present).
pub fn sign(
    creds: &Credentials,
    service: &str,
    region: &str,
    input: &SignInput<'_>,
) -> Result<String> {
    // Canonical headers: sort by lowercased name, trim values.
    let mut hdrs: Vec<(String, String)> = input
        .signed_headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    hdrs.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String = hdrs.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_names: String = hdrs
        .iter()
        .map(|(k, _)| k.clone())
        .collect::<Vec<_>>()
        .join(";");

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        input.method.to_uppercase(),
        uri_encode(input.canonical_uri, true),
        input.canonical_query,
        canonical_headers,
        signed_names,
        sha256_hex(input.payload),
    );

    let scope = format!("{}/{region}/{service}/aws4_request", input.date);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        input.amz_date,
        sha256_hex(canonical_request.as_bytes()),
    );

    let k_date = hmac(
        format!("AWS4{}", creds.secret_access_key).as_bytes(),
        input.date,
    );
    let k_region = hmac(&k_date, region);
    let k_service = hmac(&k_region, service);
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex::encode(hmac(&k_signing, &string_to_sign));

    Ok(format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_names}, Signature={signature}",
        creds.access_key_id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // AWS SigV4 test suite: get-vanilla-query-order-key-case adapted.
    // Well-known example from AWS docs (iam:GetUser), fixed timestamp.
    #[test]
    fn known_signature() {
        let creds = Credentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
        };
        // Canonical request for GET https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08
        let signed = sign(
            &creds,
            "iam",
            "us-east-1",
            &SignInput {
                method: "GET",
                canonical_uri: "/",
                canonical_query: "Action=ListUsers&Version=2010-05-08",
                signed_headers: &[
                    ("host".into(), "iam.amazonaws.com".into()),
                    ("x-amz-date".into(), "20150830T123600Z".into()),
                    (
                        "content-type".into(),
                        "application/x-www-form-urlencoded; charset=utf-8".into(),
                    ),
                ],
                payload: b"",
                amz_date: "20150830T123600Z",
                date: "20150830",
            },
        )
        .unwrap();
        // Reference signature from AWS documentation for this request.
        assert_eq!(
            signed,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
        );
    }
}

//! Runtime secret fetch (ADR-011): nothing secret lives in image env vars.
//! At /run the agent resolves the execution-role credentials (IMDSv2 or the
//! container-credentials env vars), then calls Secrets Manager with SigV4.

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::env;
use std::time::{Duration, Instant};
use time::OffsetDateTime;
use time::format_description::FormatItem;
use time::macros::format_description;

use crate::sigv4::{Credentials, SignInput, sign};

const AMZ_DATE: &[FormatItem<'static>] =
    format_description!("[year][month][day]T[hour][minute][second]Z");
const DATE: &[FormatItem<'static>] = format_description!("[year][month][day]");

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ImdsCredentials {
    access_key_id: String,
    secret_access_key: String,
    token: String,
}

// Never log credentials — redact by hand rather than risk a Debug leak.
impl std::fmt::Debug for ImdsCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImdsCredentials")
            .field("access_key_id", &"REDACTED")
            .field("secret_access_key", &"REDACTED")
            .field("token", &"REDACTED")
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct SecretValueResponse {
    #[serde(default)]
    secret_string: Option<String>,
    #[serde(default)]
    secret_binary: Option<String>,
}

/// Where the credential env vars come from: the process env in
/// production, a map in tests (edition 2024 makes `env::set_var` unsafe).
type EnvLookup<'a> = &'a (dyn Fn(&str) -> Option<String> + Sync);

/// Remaining hook budget for the next outbound request. Sequential
/// requests (IMDS token → role → credentials → Secrets Manager) share ONE
/// deadline — giving each its own fresh timeout could exceed the hook
/// deadline several times over (§5-2).
fn budget(deadline: Instant) -> Result<Duration> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        bail!("no hook budget left for secret fetch");
    }
    Ok(left)
}

/// Resolve execution-role credentials for the MicroVM.
/// Order: AWS_CONTAINER_CREDENTIALS_FULL_URI → RELATIVE_URI on the IMDS host
/// → IMDSv2 instance identity credentials.
/// These env vars are platform-injected (not user config), so a malformed
/// value is treated as absent — unlike config.rs's fail-fast policy.
async fn resolve_credentials(
    client: &reqwest::Client,
    imds_endpoint: &str,
    deadline: Instant,
    env: EnvLookup<'_>,
) -> Result<Credentials> {
    if let Some(uri) = env("AWS_CONTAINER_CREDENTIALS_FULL_URI") {
        return fetch_container_creds(client, &uri, None, deadline, env).await;
    }
    if let Some(rel) = env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") {
        let host = imds_endpoint.trim_end_matches('/');
        return fetch_container_creds(client, &format!("{host}{rel}"), None, deadline, env).await;
    }

    // IMDSv2: token first.
    let token = client
        .put(format!("{imds_endpoint}/latest/api/token"))
        .header("X-aws-ec2-metadata-token-ttl-seconds", "60")
        .timeout(budget(deadline)?)
        .send()
        .await
        .context("imds token")?
        .error_for_status()
        .context("imds token status")?
        .text()
        .await?;

    let role = client
        .get(format!(
            "{imds_endpoint}/latest/meta-data/iam/security-credentials/"
        ))
        .header("X-aws-ec2-metadata-token", &token)
        .timeout(budget(deadline)?)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let role_name = role.lines().next().unwrap_or_default().trim().to_string();
    if role_name.is_empty() {
        bail!("imds returned no role name");
    }
    fetch_container_creds(
        client,
        &format!("{imds_endpoint}/latest/meta-data/iam/security-credentials/{role_name}"),
        Some(&token),
        deadline,
        env,
    )
    .await
}

async fn fetch_container_creds(
    client: &reqwest::Client,
    uri: &str,
    token: Option<&str>,
    deadline: Instant,
    env: EnvLookup<'_>,
) -> Result<Credentials> {
    let mut req = client.get(uri).timeout(budget(deadline)?);
    if let Some(t) = token {
        req = req.header("X-aws-ec2-metadata-token", t);
    }
    if let Some(auth) = env("AWS_CONTAINER_AUTHORIZATION_TOKEN") {
        req = req.header("Authorization", auth);
    }
    let c: ImdsCredentials = req.send().await?.error_for_status()?.json().await?;
    Ok(Credentials {
        access_key_id: c.access_key_id,
        secret_access_key: c.secret_access_key,
        session_token: Some(c.token),
    })
}

/// The signed Host header must match what reqwest sends: no port for
/// the scheme's default port, host:port otherwise.
fn signed_host(endpoint: &str) -> String {
    let mut host = endpoint
        .strip_prefix("https://")
        .or_else(|| endpoint.strip_prefix("http://"))
        .unwrap_or(endpoint)
        .to_string();
    if host.ends_with(":443") && endpoint.starts_with("https://") {
        host.truncate(host.len() - 4);
    }
    if host.ends_with(":80") && endpoint.starts_with("http://") {
        host.truncate(host.len() - 3);
    }
    host
}

/// Fetch the secret string for `secret_arn` from Secrets Manager.
/// `deadline` bounds the WHOLE sequence (credential resolution + the
/// GetSecretValue call), not each request individually.
pub async fn fetch_secret(
    imds_endpoint: &str,
    secrets_endpoint: Option<&str>,
    region: &str,
    secret_arn: &str,
    deadline: Instant,
) -> Result<String> {
    let env = |k: &str| env::var(k).ok();
    fetch_secret_with(
        imds_endpoint,
        secrets_endpoint,
        region,
        secret_arn,
        deadline,
        &env,
    )
    .await
}

async fn fetch_secret_with(
    imds_endpoint: &str,
    secrets_endpoint: Option<&str>,
    region: &str,
    secret_arn: &str,
    deadline: Instant,
    env: EnvLookup<'_>,
) -> Result<String> {
    let imds_endpoint = imds_endpoint.trim_end_matches('/');
    let creds =
        resolve_credentials(&crate::local_http_client(), imds_endpoint, deadline, env).await?;

    let endpoint = secrets_endpoint
        .map(|e| e.trim_end_matches('/').to_string())
        .unwrap_or_else(|| format!("https://secretsmanager.{region}.amazonaws.com"));
    let host = signed_host(&endpoint);

    let now = OffsetDateTime::now_utc();
    let amz_date = now.format(&AMZ_DATE).context("format amz date")?;
    let date = now.format(&DATE).context("format date")?;

    let body = serde_json::to_vec(&serde_json::json!({"SecretId": secret_arn}))?;
    let mut headers: Vec<(String, String)> = vec![
        ("host".into(), host.clone()),
        ("x-amz-date".into(), amz_date.clone()),
        ("content-type".into(), "application/x-amz-json-1.1".into()),
        (
            "x-amz-target".into(),
            "secretsmanager.GetSecretValue".into(),
        ),
    ];
    if let Some(t) = &creds.session_token {
        headers.push(("x-amz-security-token".into(), t.clone()));
    }
    let signed = sign(
        &creds,
        "secretsmanager",
        region,
        &SignInput {
            method: "POST",
            canonical_uri: "/",
            canonical_query: "",
            signed_headers: &headers,
            payload: &body,
            amz_date: &amz_date,
            date: &date,
        },
    )?;

    // Secrets Manager is the one off-VM call — it keeps the system proxy
    // settings, for VPCs whose only egress is a proxy.
    let mut req = reqwest::Client::new()
        .post(&endpoint)
        .body(body)
        .timeout(budget(deadline)?);
    for (k, v) in &headers {
        if k != "host" {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    req = req.header("authorization", signed);

    let resp: SecretValueResponse = req.send().await?.error_for_status()?.json().await?;
    if let Some(s) = resp.secret_string {
        return Ok(s);
    }
    if let Some(b) = resp.secret_binary {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b)?;
        return Ok(String::from_utf8(bytes)?);
    }
    bail!("secret response had neither SecretString nor SecretBinary")
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::{BodyExt, Full};
    use hyper::body::{Bytes, Incoming};
    use hyper::service::service_fn;
    use hyper::{Request, Response, StatusCode};
    use hyper_util::rt::TokioIo;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    const ARN: &str = "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:kagero";
    const REGION: &str = "ap-northeast-1";

    struct Seen {
        method: String,
        path: String,
        headers: hyper::HeaderMap,
        body: Bytes,
    }

    /// IMDSv2, the container-credentials endpoint and Secrets Manager on
    /// one loopback port, answering `secret` to GetSecretValue.
    async fn mock_aws(secret: serde_json::Value) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let log = log.clone();
                let secret = secret.clone();
                let svc = service_fn(move |req: Request<Incoming>| {
                    let log = log.clone();
                    let secret = secret.clone();
                    async move {
                        let (parts, body) = req.into_parts();
                        let body = body.collect().await?.to_bytes();
                        let path = parts.uri.path().to_string();
                        let reply = match (parts.method.as_str(), path.as_str()) {
                            ("PUT", "/latest/api/token") => Some("imds-token".to_string()),
                            ("GET", "/latest/meta-data/iam/security-credentials/") => {
                                Some("exec-role\n".to_string())
                            }
                            (
                                "GET",
                                "/latest/meta-data/iam/security-credentials/exec-role"
                                | "/creds-full"
                                | "/creds-rel",
                            ) => Some(
                                json!({
                                    "AccessKeyId": "AKIDEXAMPLE",
                                    "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                                    "Token": "session-token",
                                })
                                .to_string(),
                            ),
                            ("POST", "/") => Some(secret.to_string()),
                            _ => None,
                        };
                        log.lock().unwrap().push(Seen {
                            method: parts.method.to_string(),
                            path,
                            headers: parts.headers,
                            body,
                        });
                        let (status, body) = match reply {
                            Some(r) => (StatusCode::OK, r),
                            None => (StatusCode::NOT_FOUND, String::new()),
                        };
                        let mut resp = Response::new(Full::new(Bytes::from(body)));
                        *resp.status_mut() = status;
                        Ok::<_, hyper::Error>(resp)
                    }
                });
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), svc)
                        .await;
                });
            }
        });
        (base, seen)
    }

    async fn fetch(base: &str, env: &[(&str, String)]) -> Result<String> {
        let env: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        let lookup = move |k: &str| env.get(k).cloned();
        fetch_secret_with(
            base,
            Some(base),
            REGION,
            ARN,
            Instant::now() + Duration::from_secs(5),
            &lookup,
        )
        .await
    }

    fn header<'a>(seen: &'a Seen, name: &str) -> &'a str {
        seen.headers
            .get(name)
            .unwrap_or_else(|| panic!("{} {} lacks {name}", seen.method, seen.path))
            .to_str()
            .unwrap()
    }

    #[test]
    fn signed_host_drops_only_the_scheme_default_port() {
        for (endpoint, host) in [
            (
                "https://secretsmanager.ap-northeast-1.amazonaws.com",
                "secretsmanager.ap-northeast-1.amazonaws.com",
            ),
            ("https://vpce.example.com:443", "vpce.example.com"),
            ("http://127.0.0.1:80", "127.0.0.1"),
            ("http://127.0.0.1:4566", "127.0.0.1:4566"),
            ("https://host:80", "host:80"),
            ("http://host:443", "host:443"),
        ] {
            assert_eq!(signed_host(endpoint), host, "{endpoint}");
        }
    }

    /// IMDSv2 end to end: token, role, role credentials, then a signed
    /// GetSecretValue whose signature holds for the Host reqwest sent.
    #[tokio::test]
    async fn imds_credentials_sign_the_secret_request() {
        let (base, seen) = mock_aws(json!({"SecretString": "s3cr3t"})).await;
        assert_eq!(fetch(&base, &[]).await.unwrap(), "s3cr3t");

        let seen = seen.lock().unwrap();
        let calls: Vec<_> = seen
            .iter()
            .map(|s| format!("{} {}", s.method, s.path))
            .collect();
        assert_eq!(
            calls,
            [
                "PUT /latest/api/token",
                "GET /latest/meta-data/iam/security-credentials/",
                "GET /latest/meta-data/iam/security-credentials/exec-role",
                "POST /",
            ]
        );
        assert_eq!(header(&seen[1], "x-aws-ec2-metadata-token"), "imds-token");
        assert_eq!(header(&seen[2], "x-aws-ec2-metadata-token"), "imds-token");

        let sm = &seen[3];
        assert_eq!(header(sm, "x-amz-target"), "secretsmanager.GetSecretValue");
        assert_eq!(header(sm, "x-amz-security-token"), "session-token");
        assert_eq!(
            sm.body,
            serde_json::to_vec(&json!({"SecretId": ARN})).unwrap()
        );
        let amz_date = header(sm, "x-amz-date");
        let signed_headers: Vec<(String, String)> = [
            "host",
            "x-amz-date",
            "content-type",
            "x-amz-target",
            "x-amz-security-token",
        ]
        .iter()
        .map(|k| (k.to_string(), header(sm, k).to_string()))
        .collect();
        let expected = sign(
            &Credentials {
                access_key_id: "AKIDEXAMPLE".into(),
                secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
                session_token: Some("session-token".into()),
            },
            "secretsmanager",
            REGION,
            &SignInput {
                method: "POST",
                canonical_uri: "/",
                canonical_query: "",
                signed_headers: &signed_headers,
                payload: &sm.body,
                amz_date,
                date: &amz_date[..8],
            },
        )
        .unwrap();
        assert_eq!(header(sm, "authorization"), expected);
    }

    /// FULL_URI wins over RELATIVE_URI and IMDS, carries the container
    /// authorization token, and a SecretBinary is base64-decoded.
    #[tokio::test]
    async fn container_credentials_take_precedence() {
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode("bin-s3cr3t");
        let (base, seen) = mock_aws(json!({"SecretBinary": encoded})).await;
        let secret = fetch(
            &base,
            &[
                (
                    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
                    format!("{base}/creds-full"),
                ),
                (
                    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                    "/creds-rel".into(),
                ),
                ("AWS_CONTAINER_AUTHORIZATION_TOKEN", "container-auth".into()),
            ],
        )
        .await
        .unwrap();
        assert_eq!(secret, "bin-s3cr3t");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].path, "/creds-full");
        assert_eq!(header(&seen[0], "authorization"), "container-auth");
        assert_eq!(header(&seen[1], "x-amz-security-token"), "session-token");
    }

    #[tokio::test]
    async fn relative_uri_resolves_against_the_metadata_host() {
        let (base, seen) = mock_aws(json!({"SecretString": "s3cr3t"})).await;
        let env = [(
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
            "/creds-rel".into(),
        )];
        assert_eq!(fetch(&base, &env).await.unwrap(), "s3cr3t");
        let paths: Vec<_> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.path.clone())
            .collect();
        assert_eq!(paths, ["/creds-rel", "/"]);
    }

    #[tokio::test]
    async fn a_response_without_a_secret_is_an_error() {
        let (base, _) = mock_aws(json!({"Name": "kagero"})).await;
        assert!(fetch(&base, &[]).await.is_err());
    }
}

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
) -> Result<Credentials> {
    if let Ok(uri) = env::var("AWS_CONTAINER_CREDENTIALS_FULL_URI") {
        return fetch_container_creds(client, &uri, None, deadline).await;
    }
    if let Ok(rel) = env::var("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") {
        let host = imds_endpoint.trim_end_matches('/');
        return fetch_container_creds(client, &format!("{host}{rel}"), None, deadline).await;
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
    )
    .await
}

async fn fetch_container_creds(
    client: &reqwest::Client,
    uri: &str,
    token: Option<&str>,
    deadline: Instant,
) -> Result<Credentials> {
    let mut req = client.get(uri).timeout(budget(deadline)?);
    if let Some(t) = token {
        req = req.header("X-aws-ec2-metadata-token", t);
    }
    if let Ok(auth) = env::var("AWS_CONTAINER_AUTHORIZATION_TOKEN") {
        req = req.header("Authorization", auth);
    }
    let c: ImdsCredentials = req.send().await?.error_for_status()?.json().await?;
    Ok(Credentials {
        access_key_id: c.access_key_id,
        secret_access_key: c.secret_access_key,
        session_token: Some(c.token),
    })
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
    let client = reqwest::Client::new();
    let imds_endpoint = imds_endpoint.trim_end_matches('/');
    let creds = resolve_credentials(&client, imds_endpoint, deadline).await?;

    let endpoint = secrets_endpoint
        .map(|e| e.trim_end_matches('/').to_string())
        .unwrap_or_else(|| format!("https://secretsmanager.{region}.amazonaws.com"));
    // The signed Host header must match what reqwest sends: no port for
    // default ports, host:port otherwise.
    let mut host = endpoint
        .strip_prefix("https://")
        .or_else(|| endpoint.strip_prefix("http://"))
        .unwrap_or(&endpoint)
        .to_string();
    if host.ends_with(":443") && endpoint.starts_with("https://") {
        host.truncate(host.len() - 4);
    }
    if host.ends_with(":80") && endpoint.starts_with("http://") {
        host.truncate(host.len() - 3);
    }

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

    let mut req = client.post(&endpoint).body(body).timeout(budget(deadline)?);
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

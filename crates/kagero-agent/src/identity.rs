//! Instance identity built at /run (microvms.md §8) and tenancy extraction
//! from runHookPayload via configured JSON Pointers (RFC 6901).

use serde_json::Value;

use crate::semconv_gen as sem;

#[derive(Debug, Clone, Default)]
pub struct Identity {
    pub microvm_id: String,
    pub tenant_id: Option<String>,
    pub session_id: Option<String>,
}

/// RFC 6901 syntax: empty (the whole document), or '/'-prefixed with
/// every '~' followed by '0' or '1'. A non-empty pointer without the
/// leading '/' is a config error, not a relative lookup, and other '~'
/// escapes are malformed input, not a literal key.
pub fn pointer_is_valid(pointer: &str) -> bool {
    if pointer.is_empty() {
        return true;
    }
    if !pointer.starts_with('/') {
        return false;
    }
    let mut chars = pointer.chars();
    while let Some(c) = chars.next() {
        if c == '~' && !matches!(chars.next(), Some('0') | Some('1')) {
            return false;
        }
    }
    true
}

/// RFC 6901 JSON Pointer lookup returning a scalar as String.
pub fn json_pointer(doc: &Value, pointer: &str) -> Option<String> {
    if !pointer_is_valid(pointer) {
        return None;
    }
    let Some(rest) = pointer.strip_prefix('/') else {
        return scalar(doc);
    };
    let mut cur = doc;
    // Only the leading '/' is structural — later empty segments are the
    // real "" key (RFC 6901: "/" dereferences key "", "//k" is doc[""]["k"]).
    for raw in rest.split('/') {
        // Decode order matters: ~1 → '/' first, then ~0 → '~', so the
        // valid RFC sequence "~01" yields the key "~1".
        let token = raw.replace("~1", "/").replace("~0", "~");
        cur = match cur {
            Value::Object(m) => m.get(&token)?,
            // RFC 6901 array-index grammar: "0" or a nonzero digit then
            // digits — "01" is NOT index 1, it simply fails to resolve.
            Value::Array(a) => {
                let valid = !token.is_empty()
                    && token.bytes().all(|b| b.is_ascii_digit())
                    && (token.len() == 1 || !token.starts_with('0'));
                if !valid {
                    return None;
                }
                a.get(token.parse::<usize>().ok()?)?
            }
            _ => return None,
        };
    }
    scalar(cur)
}

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Parse the /run request body. runHookPayload may be a JSON value or a
/// string; a string containing JSON is parsed so pointers still apply.
pub fn identity_from_run_body(
    body: &Value,
    tenant_pointer: Option<&str>,
    session_pointer: Option<&str>,
) -> Identity {
    let microvm_id = body
        .get("microvmId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    // runHookPayload is only read for the configured pointers; the raw body
    // is forwarded to the app untouched by the relay (never logged).
    let payload = body.get("runHookPayload").cloned();
    let payload_doc: Option<Value> = match &payload {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok().or(payload.clone()),
        other => other.clone(),
    };

    let lookup = |p: Option<&str>| -> Option<String> {
        let p = p?;
        let doc = payload_doc.as_ref()?;
        json_pointer(doc, p).map(|s| sanitize_id(&s))
    };

    Identity {
        microvm_id: sanitize_id(&microvm_id),
        tenant_id: lookup(tenant_pointer),
        session_id: lookup(session_pointer),
    }
}

/// Ids flow into config templates that are evaluated in three hostile
/// contexts — YAML/river strings, unquoted env-file lines, and `sh`
/// sourced files — so the charset is an ALLOWLIST, not a blocklist:
/// alphanumerics plus `._-@:/+=` (AWS id characters). This excludes
/// every shell metachar (`$`, backtick, `;&|()<>~'"\\` etc.), all
/// whitespace, and all placeholder braces. Also caps the length
/// (defense in depth; the renderer additionally fails closed on
/// leftover placeholder marks).
fn sanitize_id(s: &str) -> String {
    s.chars()
        .filter(|c| {
            c.is_ascii_alphanumeric() || matches!(*c, '.' | '_' | '-' | '@' | ':' | '/' | '+' | '=')
        })
        .take(256)
        .collect()
}

/// Attributes the collector must stamp on every piece of telemetry
/// (overwriting whatever the app claimed — threat model, "自己申告").
pub fn identity_attributes(
    id: &Identity,
    image_name: &str,
    image_version: &str,
    size: &str,
    region: &str,
) -> Vec<(String, String)> {
    let mut v = vec![
        // service.name=kagero gives Loki the service_name stream label
        // (and overwrites whatever the app claimed for it).
        (sem::ATTR_SERVICE_NAME.into(), "kagero".into()),
        (sem::ATTR_SERVICE_INSTANCE_ID.into(), id.microvm_id.clone()),
        (sem::ATTR_FAAS_INSTANCE.into(), id.microvm_id.clone()),
        (
            sem::ATTR_KAGERO_MICROVM_IMAGE_NAME.into(),
            image_name.to_string(),
        ),
        (
            sem::ATTR_KAGERO_MICROVM_IMAGE_VERSION.into(),
            image_version.to_string(),
        ),
        (sem::ATTR_KAGERO_MICROVM_SIZE.into(), size.to_string()),
        (sem::ATTR_CLOUD_PROVIDER.into(), "aws".into()),
        (sem::ATTR_CLOUD_REGION.into(), region.to_string()),
    ];
    if let Some(t) = &id.tenant_id {
        v.push((sem::ATTR_KAGERO_TENANT_ID.into(), t.clone()));
    }
    if let Some(s) = &id.session_id {
        v.push((sem::ATTR_KAGERO_SESSION_ID.into(), s.clone()));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_pointer_basic() {
        let doc = json!({"tenant": {"id": "t-1"}, "list": ["a", "b"]});
        assert_eq!(json_pointer(&doc, "/tenant/id"), Some("t-1".into()));
        assert_eq!(json_pointer(&doc, "/list/1"), Some("b".into()));
        assert_eq!(json_pointer(&doc, "/missing"), None);
        assert_eq!(json_pointer(&doc, "/list/9"), None);
        // RFC 6901: a leading zero is not a valid array index — "01"
        // must not silently resolve as element 1.
        assert_eq!(json_pointer(&doc, "/list/01"), None);
        assert_eq!(json_pointer(&doc, "/list/0"), Some("a".into()));
        // A non-empty pointer must start with '/'; bad escapes rejected.
        assert_eq!(json_pointer(&doc, "tenant/id"), None);
        assert_eq!(json_pointer(&doc, "/a~2b"), None);
        assert_eq!(json_pointer(&doc, "/a~"), None);
        // "~01" is the RFC encoding of the literal key "~1".
        let esc = json!({"~1": "ok"});
        assert_eq!(json_pointer(&esc, "/~01"), Some("ok".into()));
    }

    #[test]
    fn json_pointer_empty_segments_are_real_keys() {
        let doc = json!({"": {"k": "v"}, "a": {"": 1}});
        assert_eq!(json_pointer(&doc, "//k"), Some("v".into()));
        assert_eq!(json_pointer(&doc, "/a/"), Some("1".into()));
        let doc2 = json!({"": "empty-key"});
        assert_eq!(json_pointer(&doc2, "/"), Some("empty-key".into()));
        // A "" key that is an object still resolves to no scalar.
        assert_eq!(json_pointer(&doc, "/"), None);
    }

    #[test]
    fn pointer_syntax() {
        for ok in ["", "/", "/tenant/id", "//k", "/a~1b/~0key", "/~01"] {
            assert!(pointer_is_valid(ok), "{ok:?} is a valid pointer");
        }
        for bad in ["tenant/id", "tenant", "/a~2b", "/a~", "/~/x", "~0"] {
            assert!(!pointer_is_valid(bad), "{bad:?} is not a valid pointer");
        }
    }

    #[test]
    fn json_pointer_escapes() {
        let doc = json!({"a/b": {"~key": 7}});
        assert_eq!(json_pointer(&doc, "/a~1b/~0key"), Some("7".into()));
    }

    #[test]
    fn identity_extraction() {
        let body = json!({
            "microvmId": "mvm-123",
            "runHookPayload": {"tenant": {"id": "acme"}, "session": "s-9"},
        });
        let id = identity_from_run_body(&body, Some("/tenant/id"), Some("/session"));
        assert_eq!(id.microvm_id, "mvm-123");
        assert_eq!(id.tenant_id.as_deref(), Some("acme"));
        assert_eq!(id.session_id.as_deref(), Some("s-9"));
    }

    /// Ids land inside `sh`-sourced env files and YAML/river strings —
    /// every shell metachar and brace must be stripped on the way in.
    #[test]
    fn sanitize_id_strips_shell_metachars() {
        let hostile = "$(id)`whoami`;x&y|z<w>v~u't\"e\\n {brace}comma,tab\tCR\rNL\nfin!";
        let clean = sanitize_id(hostile);
        assert!(
            clean.chars().all(|c| c.is_ascii_alphanumeric()
                || matches!(c, '.' | '_' | '-' | '@' | ':' | '/' | '+' | '=')),
            "sanitized id still carries a dangerous char: {clean:?}"
        );
        assert!(!clean.contains('$'));
        assert!(!clean.contains('`'));
        assert!(!clean.contains(';'));
        assert!(!clean.contains('{'));
        assert_eq!(sanitize_id("ok-tenant_1.2"), "ok-tenant_1.2");
    }

    #[test]
    fn identity_from_string_payload() {
        let body = json!({
            "microvmId": "mvm-9",
            "runHookPayload": "{\"tenant\": {\"id\": \"acme\"}}",
        });
        let id = identity_from_run_body(&body, Some("/tenant/id"), None);
        assert_eq!(id.tenant_id.as_deref(), Some("acme"));
    }
}

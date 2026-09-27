//! Registry-completeness test: every
//! `kagero.*`/`service.*`/`cloud.*`/`faas.*` string literal in the agent
//! sources must be a registered semconv attribute id or metric name —
//! otherwise the registry stops being the source of truth and codegen
//! (TS constants, strip lists, docs) silently drifts from what the agent
//! actually emits.
//!
//! Literals that are NOT semconv names — stdout event names, env-var-ish
//! keys — live in KNOWN_NON_ATTRIBUTES below; add entries deliberately.

use std::collections::HashSet;
use std::path::PathBuf;

use crate::semconv_gen as sem;

/// stdout JSON-event names and format templates that are intentionally
/// not semconv attribute ids (they are log-record body names).
const KNOWN_NON_ATTRIBUTES: &[&str] = &[
    "kagero.hook.result",
    "kagero.lifecycle.degraded",
    "kagero.lifecycle.degraded.otlp_failed",
    "kagero.usage.summary",
    "kagero.usage.push_failed",
    "kagero.app.spawn_failed",
];

/// Extract `"..."` literals that look like semconv names. Handles escapes
/// enough for our sources; raw strings (r#"..."#) are captured by their
/// inner content, which is what we want.
fn semconv_literals(text: &str) -> Vec<String> {
    const PREFIXES: [&str; 4] = ["kagero.", "service.", "cloud.", "faas."];
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '"' {
            continue;
        }
        let mut s = String::new();
        while let Some(c) = chars.next() {
            match c {
                '"' => break,
                '\\' => {
                    if let Some(n) = chars.next() {
                        s.push(n);
                    }
                }
                _ => s.push(c),
            }
        }
        if PREFIXES.iter().any(|p| s.starts_with(p))
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '{')
        {
            out.push(s);
        }
    }
    out
}

#[test]
fn source_literals_are_registered() {
    let src_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut known: HashSet<String> = sem::ALL_ATTRIBUTE_IDS
        .iter()
        .chain(sem::ALL_METRIC_NAMES.iter())
        .map(|s| (*s).to_string())
        .collect();
    for n in KNOWN_NON_ATTRIBUTES {
        known.insert((*n).to_string());
    }

    let mut offenders: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&src_dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        // The generated file defines the constants — skip it.
        if path.file_name().unwrap() == "semconv_gen.rs" {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        for lit in semconv_literals(&text) {
            // Skip format templates ("kagero.lifecycle.{name}") — the
            // concrete produced names are covered by KNOWN_NON_ATTRIBUTES.
            if lit.contains('{') || lit.trim_end_matches('.').len() != lit.len() {
                continue;
            }
            if !known.contains(&lit) {
                offenders.push(format!(
                    "{}: {lit}",
                    path.file_name().unwrap().to_string_lossy()
                ));
            }
        }
    }
    offenders.sort();
    offenders.dedup();
    assert!(
        offenders.is_empty(),
        "unregistered semconv-looking literals in agent sources: {offenders:?}\n\
         register them in semconv/registry/kagero.yaml (pnpm generate) or add\n\
         an explicit entry to KNOWN_NON_ATTRIBUTES in semconv_drift.rs"
    );
}

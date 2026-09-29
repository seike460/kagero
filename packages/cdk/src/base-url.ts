/**
 * Synth-time mirror of the base-URL check that the durable stitcher
 * applies at init: an absolute http(s) URL with a host, an optional port
 * and an optional prefix path. It appends /v1/<signal> to the value as
 * text, so a query or fragment would come before it, fetch refuses
 * userinfo, and whitespace that the URL parser trims from the value
 * alone breaks the joined URL.
 */

import { Token } from "aws-cdk-lib";

function isBaseUrl(v: string): boolean {
  const scheme = /^https?:\/\//i.exec(v);
  // The authority ends at / \ ? # as in the WHATWG parser; an "@" in it
  // is userinfo, even an empty one ("https://@host").
  const authority = scheme ? (v.slice(scheme[0].length).split(/[/\\?#]/, 1)[0] ?? "") : "";
  if (authority === "" || authority.includes("@") || /[?#\s\p{Cc}]/u.test(v)) return false;
  try {
    return new URL(v).hostname !== "";
  } catch {
    return false;
  }
}

/** Throws when `v` is not a base URL. The error names `label`, not the
 *  value, which may carry a token. An unresolved token is left to the
 *  handler's check at init. */
export function checkBaseUrl(label: string, v: string): void {
  if (Token.isUnresolved(v) || isBaseUrl(v)) return;
  throw new Error(
    `${label} must be an absolute http:// or https:// URL with a host, ` +
      "and no query, fragment, userinfo or whitespace",
  );
}

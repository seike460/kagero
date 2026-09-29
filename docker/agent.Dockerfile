# kagero agent OCI image (docs/design/architecture.md §11: the agent image
# is published to GHCR). The image carries the statically linked binary
# and the license texts that ship with it — consumers copy the binary
# (and, when they redistribute their image, /LICENSE and /licenses) into
# their own MicroVM image:
#   COPY --from=ghcr.io/seike460/kagero:0.1 /kagero /usr/local/bin/kagero
#
# Alpine's rust toolchain is musl-native, so the release binary is
# static with no glibc dependency — safe to drop into any base image.
# build-base provides the C toolchain ring (reqwest rustls) needs.
# Pinned to the same Rust as mise.toml so the release matches CI, and by
# digest so a rebuild of the same tag gets the same Alpine and musl —
# bump the tag and the digest together with mise.toml.

FROM rust:1.98.1-alpine3.24@sha256:7cc1c22d77d9432f7fe012a70e6d3e555af54c2a6832700ed7d553f1769ae89f AS build
RUN apk add --no-cache build-base
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked -p kagero-agent
# License texts for everything linked into the binary: every crate the
# build fetched, and the Rust standard library, whose notice also covers
# the statically linked musl. A crate without a license file fails the
# build rather than shipping without its notice.
RUN set -eu; \
    for d in "$CARGO_HOME"/registry/src/*/*/; do \
      n=$(basename "$d"); \
      mkdir -p "/licenses/crates/$n"; \
      for f in "$d"LICEN[CS]E* "$d"COPYING* "$d"NOTICE*; do \
        if [ -f "$f" ]; then cp "$f" "/licenses/crates/$n/"; fi; \
      done; \
      if [ -z "$(ls -A "/licenses/crates/$n")" ]; then \
        echo "no license file in crate $n" >&2; exit 1; \
      fi; \
    done; \
    cp "$RUSTUP_HOME"/toolchains/*/share/doc/rust/COPYRIGHT-library.html \
      /licenses/rust-std-COPYRIGHT.html

FROM scratch
COPY LICENSE /LICENSE
COPY --from=build /licenses /licenses
COPY --from=build /src/target/release/kagero /kagero
ENTRYPOINT ["/kagero"]

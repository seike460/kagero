# kagero agent OCI image (docs/design/architecture.md §11: the agent image
# is published to GHCR). The image carries ONLY the statically linked
# binary — consumers copy it into their own MicroVM image:
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

FROM scratch
COPY --from=build /src/target/release/kagero /kagero
ENTRYPOINT ["/kagero"]

# kagero MicroVM image — Node.js example (microvms.md §10).
# Build from the REPO ROOT so the collector template is in context
# (arm64 only — the base and agent images are linux/arm64):
#   docker build --platform linux/arm64 -f examples/node/Dockerfile -t kagero-example-node .
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# The agent binary — from the released OCI image. To try unreleased
# agent changes, build it into the context root:
#   docker build --platform linux/arm64 -f docker/agent.Dockerfile -o . .
# then replace the line below with:
#   COPY kagero /usr/local/bin/kagero
COPY --from=ghcr.io/seike460/kagero:0.1 /kagero /usr/local/bin/kagero

# Collector + the rendered-on-/run config template. Without a collector
# the agent is supervisor-only and exports no telemetry.
COPY --from=grafana/alloy:v1.20.0 /bin/alloy /usr/local/bin/alloy
COPY collector/alloy/lgtm.alloy.tmpl /etc/kagero/collector.alloy.tmpl

# App runtime + code.
RUN dnf install -y nodejs && dnf clean all
COPY examples/node/app /app

# Non-secret config — matches the KageroMicrovmImage construct's env.
ENV KAGERO_BACKEND=lgtm \
    KAGERO_HOOK_PORT=2018 \
    KAGERO_APP_HOOK_PORT=2019 \
    KAGERO_OTLP_PORT=4318 \
    KAGERO_ADMIN_PORT=2020 \
    KAGERO_MICROVM_BASELINE_GIB=2 \
    KAGERO_MICROVM_BASELINE_VCPU=1 \
    KAGERO_COLLECTOR_BIN=/usr/local/bin/alloy \
    KAGERO_COLLECTOR_START=run \
    KAGERO_COLLECTOR_ARGS="[\"run\",\"--storage.path=/run/kagero/collector-data\",\"{config}\"]" \
    KAGERO_MICROVM_IMAGE_NAME=example-node \
    KAGERO_MICROVM_IMAGE_VERSION=0.1.0 \
    KAGERO_AWS_REGION=us-east-1 \
    KAGERO_COLLECTOR_CONFIG_TEMPLATE=/etc/kagero/collector.alloy.tmpl \
    KAGERO_COLLECTOR_CONFIG_OUT=/tmp/collector.alloy \
    KAGERO_OTLP_ENDPOINT_LGTM=https://otlp.invalid
# KAGERO_OTLP_ENDPOINT_LGTM is a PLACEHOLDER — an unresolvable name so
# a misconfigured image fails visibly instead of looping telemetry
# back into the collector's own receiver (localhost:4318).
# This template's LGTM exporter also needs credentials: set
# KAGERO_SECRET_ARN to a Secrets Manager JSON {"username","password"}
# or the rendered config fails closed and no telemetry is exported.
# Secrets never go in ENV themselves (ADR-011).

ENTRYPOINT ["/usr/local/bin/kagero", "--"]
CMD ["node", "/app/index.mjs"]

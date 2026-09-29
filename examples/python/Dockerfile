# kagero MicroVM image — Python example (microvms.md §10).
# Build from the REPO ROOT so the collector template is in context
# (arm64 only — the base and agent images are linux/arm64):
#   docker build --platform linux/arm64 -f examples/python/Dockerfile -t kagero-example-python .
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# Unreleased agent changes: build the agent into the context root
# (docker build --platform linux/arm64 -f docker/agent.Dockerfile -o . .)
# and swap the next line for:
#   COPY kagero /usr/local/bin/kagero
COPY --from=ghcr.io/seike460/kagero:0.1 /kagero /usr/local/bin/kagero
COPY --from=grafana/alloy:v1.20.0 /bin/alloy /usr/local/bin/alloy
COPY collector/alloy/lgtm.alloy.tmpl /etc/kagero/collector.alloy.tmpl

RUN dnf install -y python3 && dnf clean all
COPY examples/python/app /app

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
    KAGERO_MICROVM_IMAGE_NAME=example-python \
    KAGERO_MICROVM_IMAGE_VERSION=0.1.0 \
    KAGERO_AWS_REGION=us-east-1 \
    KAGERO_COLLECTOR_CONFIG_TEMPLATE=/etc/kagero/collector.alloy.tmpl \
    KAGERO_COLLECTOR_CONFIG_OUT=/tmp/collector.alloy \
    KAGERO_OTLP_ENDPOINT_LGTM=https://otlp.invalid
# PLACEHOLDER — unresolvable so a misconfigured image fails visibly
# (localhost:4318 would loop telemetry into the collector's receiver).
# The LGTM template also needs KAGERO_SECRET_ARN → Secrets Manager
# JSON {"username","password"} — no credentials in ENV (ADR-011).

ENTRYPOINT ["/usr/local/bin/kagero", "--"]
CMD ["python3", "/app/main.py"]

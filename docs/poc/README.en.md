# PoC runbooks

> English translation of [README.md](README.md) (Japanese is canonical). Last synced: 2026-09-27.

- Purpose: verify the design's assumptions on real AWS, and use the results to decide the ADRs.
- The scope of M0 (the PoC gate) is PoC-01 through PoC-05. No implementation code is written until M0 is passed (implementation has already proceeded ahead; the deviation is recorded in [ADR-012](../decisions.en.md). The role of the PoCs shifts from "verification before building" to "verification of something that works").
- Last updated: 2026-09-26

## List

| # | Title | Priority | What it decides | Status |
|---|---|---|---|---|
| 01 | [Runtime environment (Japanese)](01-runtime-environment.md) | P0 | ADR-011, how to send to CloudWatch, distribution method | not run |
| 02 | [Hook behavior (Japanese)](02-hook-contract.md) | P0 | ADR-004 | not run |
| 03 | [Snapshot safety (Japanese)](03-snapshot-safety.md) | P0 | ADR-005 | not run |
| 04 | [Flush and collector (Japanese)](04-flush-and-collector.md) | P0 | ADR-006, ADR-007 | not run |
| 05 | [Backend differences (Japanese)](05-backend-parity.md) | P0 | ADR-002, ADR-008, ADR-010 | not run |
| 06 | [Dashboard delivery (Japanese)](06-dashboard-delivery.md) | P1 | ADR-010 | not run |
| 07 | [Lambda function data (Japanese)](07-functions-data.md) | P1 | Module B's data path | not run |
| 08 | [Durable stitching (Japanese)](08-durable-stitching.md) | P1 | Module D's approach | not run |
| 09 | [Cost reconciliation (Japanese)](09-cost-reconciliation.md) | P1 | ADR-009 | not run |
| 10 | [k6 and eBPF (Japanese)](10-k6-and-ebpf.md) | P2 | Module C's design, handling of eBPF | not run |

## Shared safety measures

- Use a dedicated AWS account for verification. Do not use a production account.
- Use the Tokyo region (ap-northeast-1).
- Set a budget alert at $30 and notify when it reaches 50%.
- Tag every resource with `project=kagero`, `poc=<number>`, and `ttl=<planned deletion date>`.
- Keep `maximumDurationInSeconds` of MicroVMs at or below 1800.
- Use only dummy secrets.
- For the LGTM side, use the Grafana Cloud free tier. Local environments that AWS cannot reach are used only for checking the simulator.
- Put raw result data in `poc-output/`. This directory is excluded from Git.
- Do not write AWS account IDs, endpoint URLs, or tokens in summaries. Redact them if necessary.
- Cost estimates are calculated with us-east-1 ARM unit prices. Tokyo pricing is verified in PoC-09.

## Teardown checklist

After every PoC, verify all of the following.

- [ ] No running or stopped MicroVMs remain (`aws lambda-microvms list-microvms`).
- [ ] MicroVM images and versions are deleted.
- [ ] Network connectors are deleted.
- [ ] Lambda functions, Durable Functions, Step Functions, and EventBridge rules are deleted.
- [ ] Firehose streams are deleted.
- [ ] CloudTrail data event settings are reverted.
- [ ] If Transaction Search was enabled, it is reverted to the original setting.
- [ ] CloudWatch log groups (such as `/aws/lambda-microvms/*`) are deleted.
- [ ] Amazon Managed Grafana workspaces are deleted.
- [ ] Dummy secrets in Secrets Manager are deleted.
- [ ] IAM roles and S3 buckets are deleted.
- [ ] Searched by the `project=kagero` tag and confirmed that nothing remains.

Example of searching by tag. It is unverified whether MicroVM resources are visible through this API, so always check the list above as well.

```sh
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=project,Values=kagero \
  --region ap-northeast-1
```

## Result format

Append the results to each runbook's "Results" section in the following format.

```markdown
### Results (run on YYYY-MM-DD)

- Verdict: pass / fail / pending
- Environment: region, versions of each component (kagero, collector, runtime, AWS CLI)
- Numbers: values corresponding to the pass criteria
- Findings:
- ADR updates: how ADR-NNN was changed
- Teardown: completed all checklist items (date and time verified)
```

import { type aws_lambda as lambda, aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * Grant a function read on a Secrets Manager ARN. Complete ARNs carry
 * the 6-char random suffix; a partial ARN (name only) gets the
 * wildcard suffix so it still matches.
 */
export function grantSecretRead(
  scope: Construct,
  id: string,
  arn: string,
  fn: lambda.IFunction,
): void {
  const secret = /-[0-9A-Za-z_+=/@.-]{6}$/.test(arn)
    ? secretsmanager.Secret.fromSecretCompleteArn(scope, id, arn)
    : secretsmanager.Secret.fromSecretPartialArn(scope, id, arn);
  secret.grantRead(fn);
}

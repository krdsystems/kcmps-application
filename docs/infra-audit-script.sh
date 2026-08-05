#!/usr/bin/env bash
# Run locally with: bash infra-audit-script.sh
# Requires: aws cli configured with the kcmps-claude-priv profile.
set -uo pipefail
P="kcmps-claude-priv"
R="ap-southeast-1"

hdr() { echo; echo "===== $1 ====="; }

hdr "CloudFormation stacks"
aws cloudformation list-stacks --profile "$P" --region "$R" \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query 'StackSummaries[].{Name:StackName,Status:StackStatus,Updated:LastUpdatedTime}' --output table

hdr "DynamoDB tables"
aws dynamodb list-tables --profile "$P" --region "$R" --output table
for t in kcmps kcmps-staging; do
  echo "--- describe-table $t ---"
  aws dynamodb describe-table --profile "$P" --region "$R" --table-name "$t" \
    --query 'Table.{Status:TableStatus,Streams:StreamSpecification,GSIs:GlobalSecondaryIndexes[].IndexName,PITR:"n/a"}' \
    --output json 2>&1
done

hdr "Lambda functions (name, runtime, last modified)"
aws lambda list-functions --profile "$P" --region "$R" \
  --query 'Functions[].{Name:FunctionName,Runtime:Runtime,Modified:LastModified,Arch:Architectures[0]}' --output table

hdr "API Gateway HTTP APIs"
aws apigatewayv2 get-apis --profile "$P" --region "$R" \
  --query 'Items[].{Name:Name,ApiId:ApiId,Endpoint:ApiEndpoint}' --output table
echo "--- routes per API ---"
for id in $(aws apigatewayv2 get-apis --profile "$P" --region "$R" --query 'Items[].ApiId' --output text); do
  echo "API $id routes:"
  aws apigatewayv2 get-routes --profile "$P" --region "$R" --api-id "$id" \
    --query 'Items[].{Route:RouteKey,Authorizer:AuthorizerId}' --output table
done

hdr "Cognito user pools + groups"
aws cognito-idp list-user-pools --profile "$P" --region "$R" --max-results 20 \
  --query 'UserPools[].{Name:Name,Id:Id}' --output table
for pid in $(aws cognito-idp list-user-pools --profile "$P" --region "$R" --max-results 20 --query 'UserPools[].Id' --output text); do
  echo "Pool $pid groups:"
  aws cognito-idp list-groups --profile "$P" --region "$R" --user-pool-id "$pid" \
    --query 'Groups[].{Name:GroupName,Precedence:Precedence}' --output table
  echo "Pool $pid clients:"
  aws cognito-idp list-user-pool-clients --profile "$P" --region "$R" --user-pool-id "$pid" \
    --query 'UserPoolClients[].{Name:ClientName,Id:ClientId}' --output table
done

hdr "SES account + identities (is production access live?)"
aws sesv2 get-account --profile "$P" --region "$R" --output json
aws sesv2 list-email-identities --profile "$P" --region "$R" \
  --query 'EmailIdentities[].{Identity:IdentityName,Verified:VerifiedForSendingStatus}' --output table

hdr "S3 buckets (kcmps-related)"
aws s3api list-buckets --profile "$P" --query "Buckets[?contains(Name,'kcmps')].Name" --output table

hdr "GuardDuty detectors + malware protection plans"
for did in $(aws guardduty list-detectors --profile "$P" --region "$R" --query 'DetectorIds' --output text); do
  echo "Detector $did:"
  aws guardduty get-detector --profile "$P" --region "$R" --detector-id "$did" --query '{Status:Status}' --output json
  aws guardduty list-malware-protection-plans --profile "$P" --region "$R" --output table 2>&1
done

hdr "EventBridge rules (crons)"
aws events list-rules --profile "$P" --region "$R" \
  --query 'Rules[].{Name:Name,Schedule:ScheduleExpression,State:State}' --output table

hdr "CloudFront distributions"
aws cloudfront list-distributions --profile "$P" \
  --query 'DistributionList.Items[].{Id:Id,Aliases:Aliases.Items,Status:Status,Enabled:Enabled}' --output table

hdr "Route 53 (default profile, second account)"
aws route53 list-hosted-zones --profile default --query 'HostedZones[].{Name:Name,Id:Id}' --output table 2>&1

echo
echo "===== DONE — paste everything above back to Claude ====="

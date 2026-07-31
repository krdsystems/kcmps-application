# Example parameter files

Copy the relevant block into its own untracked `*.json` file, fill in real
values, and pass it with `--parameters file://your-file.json`. **Never commit
a filled-in copy** — the Google client secret and dev basic-auth credential
are live secrets.

## `kcmps-dr-core.yaml` (deploy to ap-southeast-1)

```json
[
  { "ParameterKey": "BucketName", "ParameterValue": "kcmps-online-bucket-est-2026" },
  { "ParameterKey": "CognitoDomainPrefix", "ParameterValue": "ap-southeast-1idvaeumnp" },
  { "ParameterKey": "GoogleClientId", "ParameterValue": "REPLACE-ME.apps.googleusercontent.com" },
  { "ParameterKey": "GoogleClientSecret", "ParameterValue": "REPLACE-ME" }
]
```

## `kcmps-dr-edge.yaml` (deploy to us-east-1, after core)

```json
[
  { "ParameterKey": "BucketName", "ParameterValue": "kcmps-online-bucket-est-2026" },
  { "ParameterKey": "BucketRegionalDomainName", "ParameterValue": "<core stack output>" },
  { "ParameterKey": "AcmCertificateArn", "ParameterValue": "arn:aws:acm:us-east-1:600929977538:certificate/c2758183-3a3a-43b2-bdd6-f6c0848edfb6" },
  { "ParameterKey": "DevBasicAuthCredential", "ParameterValue": "REPLACE-ME (base64 of user:pass)" }
]
```

## `kcmps-dns-records.yaml` (deploy to the 260866268499 account, `default` profile)

```json
[
  { "ParameterKey": "CloudFrontDomainName", "ParameterValue": "<edge stack ProdDistributionDomainName output>" },
  { "ParameterKey": "DevCloudFrontDomainName", "ParameterValue": "<edge stack DevDistributionDomainName output>" }
]
```

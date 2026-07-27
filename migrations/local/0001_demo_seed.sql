PRAGMA foreign_keys = ON;

-- Local preview data only. Apply this file explicitly after the main migrations:
-- npx wrangler d1 execute DB --local --file=migrations/local/0001_demo_seed.sql

INSERT OR IGNORE INTO licenses (
  id,
  spdx_id,
  name,
  license_url,
  required_notice,
  ingestion_allowed,
  reviewed_at
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'CC0-1.0',
  'CC0 1.0 Universal',
  'https://creativecommons.org/publicdomain/zero/1.0/',
  '',
  1,
  '2026-07-26T00:00:00.000Z'
);

INSERT OR IGNORE INTO source_repositories (
  id,
  provider,
  repository,
  default_branch,
  source_url,
  license_id,
  trusted
) VALUES (
  '00000000-0000-4000-8000-000000000002',
  'local',
  'kqlbook.com/demo',
  'main',
  'https://kqlbook.com',
  '00000000-0000-4000-8000-000000000001',
  1
);

INSERT OR IGNORE INTO queries (
  id,
  owner_id,
  visibility,
  moderation_status,
  created_at,
  updated_at,
  published_at
) VALUES
  (
    'd3a1509d-9160-4dc5-b5b7-5e62ed8abaf0',
    NULL,
    'public',
    'visible',
    '2026-07-18T12:00:00.000Z',
    '2026-07-18T12:00:00.000Z',
    '2026-07-18T12:00:00.000Z'
  ),
  (
    '1299fab4-459d-48b5-964b-2bc678c32366',
    NULL,
    'public',
    'visible',
    '2026-07-11T12:00:00.000Z',
    '2026-07-11T12:00:00.000Z',
    '2026-07-11T12:00:00.000Z'
  ),
  (
    'be6a9954-39d2-44b9-82ea-c4e1c0d2a50d',
    NULL,
    'public',
    'visible',
    '2026-06-29T12:00:00.000Z',
    '2026-06-29T12:00:00.000Z',
    '2026-06-29T12:00:00.000Z'
  ),
  (
    '025ae4ab-f7ec-4fa5-ae9c-71a2de3ca9f8',
    NULL,
    'public',
    'visible',
    '2026-06-21T12:00:00.000Z',
    '2026-06-21T12:00:00.000Z',
    '2026-06-21T12:00:00.000Z'
  ),
  (
    '1a83e8bf-1cb8-47d6-be87-23706b7345f7',
    NULL,
    'public',
    'visible',
    '2026-06-17T12:00:00.000Z',
    '2026-06-17T12:00:00.000Z',
    '2026-06-17T12:00:00.000Z'
  );

INSERT OR IGNORE INTO query_versions (
  id,
  query_id,
  version_number,
  title,
  kql,
  description,
  explanation,
  dialect,
  tables_json,
  operators_json,
  tags_json,
  assumptions_json,
  validation_warnings_json,
  ai_generated,
  generation_model,
  content_hash,
  created_by_user_id,
  created_at
) VALUES
  (
    '9ab47bb2-d76d-441b-b98e-bd014c22b8f0',
    'd3a1509d-9160-4dc5-b5b7-5e62ed8abaf0',
    1,
    'Password spray across multiple countries',
    'let attemptThreshold = 8;
let countryThreshold = 2;
SigninLogs
| where TimeGenerated > ago(1h)
| where ResultType != 0
| extend Country = tostring(LocationDetails.countryOrRegion)
| summarize FailedAttempts = count(),
    Countries = make_set(Country, 10),
    CountryCount = dcount(Country),
    SourceIPs = make_set(IPAddress, 20)
  by UserPrincipalName, bin(TimeGenerated, 15m)
| where FailedAttempts >= attemptThreshold and CountryCount >= countryThreshold
| order by FailedAttempts desc',
    'Find users with repeated failed sign-ins from more than one country inside a 15-minute window.',
    'The query groups failed Entra sign-ins by user and time window. Review matching accounts with successful sign-ins, identity risk, and Conditional Access results.',
    'sentinel',
    '["SigninLogs"]',
    '["where","extend","summarize","make_set","dcount"]',
    '["identity","password-spray","entra-id"]',
    '["SigninLogs contains LocationDetails and IPAddress.","ResultType 0 means success."]',
    '[]',
    0,
    NULL,
    'demo-sentinel-v1',
    NULL,
    '2026-07-18T12:00:00.000Z'
  ),
  (
    '0eca3257-40bc-4cc6-81ae-e3d1952b1359',
    '1299fab4-459d-48b5-964b-2bc678c32366',
    1,
    'Encoded PowerShell launched by Office',
    'DeviceProcessEvents
| where Timestamp > ago(24h)
| where FileName in~ ("powershell.exe", "pwsh.exe")
| where InitiatingProcessFileName in~ (
    "winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe"
  )
| where ProcessCommandLine has_any (
    "-enc", "-encodedcommand", "-windowstyle hidden", "-noninteractive"
  )
| project Timestamp, DeviceName, AccountUpn,
    InitiatingProcessFileName, ProcessCommandLine, SHA1
| order by Timestamp desc',
    'Surface Office processes that start PowerShell with encoded or hidden-window arguments.',
    'Parent-child context reduces noise. Document automation and administrative scripts can still match, so inspect the file and process evidence.',
    'defender-xdr',
    '["DeviceProcessEvents"]',
    '["where","in~","has_any","project"]',
    '["powershell","office","execution"]',
    '["DeviceProcessEvents retention covers the selected 24-hour interval."]',
    '[]',
    0,
    NULL,
    'demo-defender-v1',
    NULL,
    '2026-07-11T12:00:00.000Z'
  ),
  (
    'cc37f585-4d16-441f-b453-0dc820f81d69',
    'be6a9954-39d2-44b9-82ea-c4e1c0d2a50d',
    1,
    'Public IP addresses without an associated network security group',
    'Resources
| where type =~ "microsoft.network/publicipaddresses"
| project publicIpId = id, publicIpName = name,
    resourceGroup, subscriptionId,
    ipAddress = tostring(properties.ipAddress)
| join kind=inner (
    Resources
    | where type =~ "microsoft.network/networkinterfaces"
    | mv-expand ipConfig = properties.ipConfigurations
    | extend publicIpId = tostring(ipConfig.properties.publicIPAddress.id)
    | extend nsgId = tostring(properties.networkSecurityGroup.id)
    | project publicIpId, nicName = name, nsgId
  ) on publicIpId
| where isempty(nsgId)
| project subscriptionId, resourceGroup, publicIpName, ipAddress, nicName',
    'List attached public IP resources whose network interface does not reference a network security group.',
    'This reports resource configuration. Validate effective security rules and the attached workload before deciding whether the address is exposed.',
    'azure-resource-graph',
    '["Resources"]',
    '["where","project","join","mv-expand","isempty"]',
    '["azure","network","exposure"]',
    '["The public IP is attached through a network interface IP configuration."]',
    '[]',
    0,
    NULL,
    'demo-resource-graph-v1',
    NULL,
    '2026-06-29T12:00:00.000Z'
  ),
  (
    '630f19e3-88ee-42d8-9e37-43c7ddfd9fe2',
    '025ae4ab-f7ec-4fa5-ae9c-71a2de3ca9f8',
    1,
    'Authentication failures by application and error code',
    'AuthenticationEvents
| where Timestamp > ago(14d)
| where Result == "Failure"
| make-series Failures = count()
    on Timestamp from ago(14d) to now() step 1h
    by Application, ErrorCode
| extend (Anomalies, Score, Baseline) =
    series_decompose_anomalies(Failures, 1.5, -1, "linefit")
| mv-expand Timestamp to typeof(datetime),
    Failures to typeof(long),
    Anomalies to typeof(double),
    Score to typeof(double),
    Baseline to typeof(double)
| where Anomalies > 0
| project Timestamp, Application, ErrorCode, Failures, Baseline, Score',
    'Summarize application authentication failures and compare each interval with its recent baseline.',
    'Replace the sample table and columns with the schema used by the target ADX cluster or Fabric eventhouse.',
    'azure-data-explorer',
    '["AuthenticationEvents"]',
    '["make-series","series_decompose_anomalies","mv-expand"]',
    '["anomaly","authentication","timeseries"]',
    '["AuthenticationEvents is a project-specific example table."]',
    '[]',
    0,
    NULL,
    'demo-adx-v1',
    NULL,
    '2026-06-21T12:00:00.000Z'
  ),
  (
    'e149ce30-6354-46ae-af76-cbd68e9b37f8',
    '1a83e8bf-1cb8-47d6-be87-23706b7345f7',
    1,
    'Device health and local storage readiness',
    'Device
| project DeviceName, Manufacturer, Model, OSVersion
| join kind=leftouter (
    LogicalDrive
    | where DriveType == 3
    | project DeviceId, DriveId, FreeSpaceBytes, SizeBytes
  ) on DeviceId
| join kind=leftouter (
    EncryptableVolume
    | project DeviceId, DriveId, ProtectionStatus, EncryptionMethod
  ) on DeviceId, DriveId
| project DeviceName, Manufacturer, Model, OSVersion, DriveId,
    FreeSpaceGB = round(FreeSpaceBytes / 1GB, 1),
    ProtectionStatus, EncryptionMethod',
    'Return device identity, operating system, free disk space, and encryption state for an Intune device query.',
    'Entity availability and property names should be checked against the Intune Device Query schema on the target device.',
    'intune-device-query',
    '["Device","LogicalDrive","EncryptableVolume"]',
    '["project","join","where","round"]',
    '["intune","device-health","encryption"]',
    '["The target device exposes the referenced Intune query entities."]',
    '[]',
    0,
    NULL,
    'demo-intune-v1',
    NULL,
    '2026-06-17T12:00:00.000Z'
  );

UPDATE queries
SET current_version_id = CASE id
    WHEN 'd3a1509d-9160-4dc5-b5b7-5e62ed8abaf0'
      THEN '9ab47bb2-d76d-441b-b98e-bd014c22b8f0'
    WHEN '1299fab4-459d-48b5-964b-2bc678c32366'
      THEN '0eca3257-40bc-4cc6-81ae-e3d1952b1359'
    WHEN 'be6a9954-39d2-44b9-82ea-c4e1c0d2a50d'
      THEN 'cc37f585-4d16-441f-b453-0dc820f81d69'
    WHEN '025ae4ab-f7ec-4fa5-ae9c-71a2de3ca9f8'
      THEN '630f19e3-88ee-42d8-9e37-43c7ddfd9fe2'
    WHEN '1a83e8bf-1cb8-47d6-be87-23706b7345f7'
      THEN 'e149ce30-6354-46ae-af76-cbd68e9b37f8'
  END
WHERE id IN (
  'd3a1509d-9160-4dc5-b5b7-5e62ed8abaf0',
  '1299fab4-459d-48b5-964b-2bc678c32366',
  'be6a9954-39d2-44b9-82ea-c4e1c0d2a50d',
  '025ae4ab-f7ec-4fa5-ae9c-71a2de3ca9f8',
  '1a83e8bf-1cb8-47d6-be87-23706b7345f7'
)
AND current_version_id IS NOT CASE id
    WHEN 'd3a1509d-9160-4dc5-b5b7-5e62ed8abaf0'
      THEN '9ab47bb2-d76d-441b-b98e-bd014c22b8f0'
    WHEN '1299fab4-459d-48b5-964b-2bc678c32366'
      THEN '0eca3257-40bc-4cc6-81ae-e3d1952b1359'
    WHEN 'be6a9954-39d2-44b9-82ea-c4e1c0d2a50d'
      THEN 'cc37f585-4d16-441f-b453-0dc820f81d69'
    WHEN '025ae4ab-f7ec-4fa5-ae9c-71a2de3ca9f8'
      THEN '630f19e3-88ee-42d8-9e37-43c7ddfd9fe2'
    WHEN '1a83e8bf-1cb8-47d6-be87-23706b7345f7'
      THEN 'e149ce30-6354-46ae-af76-cbd68e9b37f8'
  END;

INSERT OR IGNORE INTO query_provenance (
  query_id,
  source_repository_id,
  source_path,
  commit_sha,
  query_block_index,
  original_author,
  source_url,
  license_id,
  required_notice
) VALUES
  (
    'd3a1509d-9160-4dc5-b5b7-5e62ed8abaf0',
    '00000000-0000-4000-8000-000000000002',
    'sentinel/password-spray.kql',
    '0000000000000000000000000000000000000001',
    0,
    'KQL Book demo',
    'https://kqlbook.com/queries/d3a1509d-9160-4dc5-b5b7-5e62ed8abaf0',
    '00000000-0000-4000-8000-000000000001',
    ''
  ),
  (
    '1299fab4-459d-48b5-964b-2bc678c32366',
    '00000000-0000-4000-8000-000000000002',
    'defender-xdr/encoded-powershell.kql',
    '0000000000000000000000000000000000000001',
    0,
    'KQL Book demo',
    'https://kqlbook.com/queries/1299fab4-459d-48b5-964b-2bc678c32366',
    '00000000-0000-4000-8000-000000000001',
    ''
  ),
  (
    'be6a9954-39d2-44b9-82ea-c4e1c0d2a50d',
    '00000000-0000-4000-8000-000000000002',
    'resource-graph/public-ip-without-nsg.kql',
    '0000000000000000000000000000000000000001',
    0,
    'KQL Book demo',
    'https://kqlbook.com/queries/be6a9954-39d2-44b9-82ea-c4e1c0d2a50d',
    '00000000-0000-4000-8000-000000000001',
    ''
  ),
  (
    '025ae4ab-f7ec-4fa5-ae9c-71a2de3ca9f8',
    '00000000-0000-4000-8000-000000000002',
    'adx/authentication-anomalies.kql',
    '0000000000000000000000000000000000000001',
    0,
    'KQL Book demo',
    'https://kqlbook.com/queries/025ae4ab-f7ec-4fa5-ae9c-71a2de3ca9f8',
    '00000000-0000-4000-8000-000000000001',
    ''
  ),
  (
    '1a83e8bf-1cb8-47d6-be87-23706b7345f7',
    '00000000-0000-4000-8000-000000000002',
    'intune/device-health.kql',
    '0000000000000000000000000000000000000001',
    0,
    'KQL Book demo',
    'https://kqlbook.com/queries/1a83e8bf-1cb8-47d6-be87-23706b7345f7',
    '00000000-0000-4000-8000-000000000001',
    ''
  );

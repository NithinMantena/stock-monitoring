$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path '.local' | Out-Null
$keyResponse = & npx.cmd --yes supabase projects api-keys --project-ref tcfricxifanwwzgxgexj --reveal --output json
if ($LASTEXITCODE -ne 0) { throw 'Unable to obtain project keys.' }
$projectKeys = ($keyResponse -join "`n") | ConvertFrom-Json
$projectKeys | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath '.local/supabase-keys.json'
Write-Output 'Project keys saved in the ignored local setup directory; values were not printed.'

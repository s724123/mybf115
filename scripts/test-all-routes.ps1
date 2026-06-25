# test-all-routes.ps1
# 啟動伺服器，逐一測試所有路由的 HTTP 狀態碼

$ErrorActionPreference = 'Stop'

function Check-Route {
    param(
        [string]$Method,
        [string]$Path,
        [int]$Expected,
        [string]$Label,
        [string]$Body = $null
    )
    $script:Total++
    if ($Body) {
        $result = curl.exe -s -o NUL -w '%{http_code}' -X $Method "http://localhost:3000$Path" -H 'Content-Type: application/json' -d $Body
    } else {
        $result = curl.exe -s -o NUL -w '%{http_code}' -X $Method "http://localhost:3000$Path"
    }
    if ($result -eq $Expected) {
        Write-Host "  ✓ $Label"
        $script:Passed++
    } else {
        Write-Host "  ✗ $Label (expected $Expected, got $result)"
    }
}

try {
    # 啟動後端伺服器
    Write-Host 'Starting backend server...'
    $job = Start-Job -ScriptBlock {
        Set-Location (Get-Location).Path
        bun run backend.ts
    }
    Start-Sleep -Seconds 3

    $script:Total = 0
    $script:Passed = 0

    Write-Host ''
    Write-Host '===== 公開路由（預期 200） ====='
    Check-Route -Method GET -Path '/health' -Expected 200 -Label 'GET /health'
    Check-Route -Method GET -Path '/openapi/json' -Expected 200 -Label 'GET /openapi/json'
    Check-Route -Method GET -Path '/api/menu' -Expected 200 -Label 'GET /api/menu'
    Check-Route -Method GET -Path '/api/menu/1/versions' -Expected 200 -Label 'GET /api/menu/1/versions'

    Write-Host ''
    Write-Host '===== 受保護路由（無 auth → 預期 401） ====='
    Check-Route -Method GET -Path '/api/auth/me' -Expected 401 -Label 'GET /api/auth/me'
    Check-Route -Method POST -Path '/api/menu' -Expected 401 -Label 'POST /api/menu' -Body '{"name":"t","price":1,"category":"x","description":"t","image_url":"/imgs/t.webp"}'
    Check-Route -Method PATCH -Path '/api/menu/1' -Expected 401 -Label 'PATCH /api/menu/1' -Body '{"price":99,"reason":"test"}'
    Check-Route -Method DELETE -Path '/api/menu/999' -Expected 401 -Label 'DELETE /api/menu/999'
    Check-Route -Method GET -Path '/api/orders/current' -Expected 401 -Label 'GET /api/orders/current'
    Check-Route -Method GET -Path '/api/orders/history' -Expected 401 -Label 'GET /api/orders/history'
    Check-Route -Method POST -Path '/api/orders' -Expected 401 -Label 'POST /api/orders' -Body '{}'
    Check-Route -Method GET -Path '/api/orders/1' -Expected 401 -Label 'GET /api/orders/1'
    Check-Route -Method PATCH -Path '/api/orders/1' -Expected 401 -Label 'PATCH /api/orders/1' -Body '{"logicalId":1,"qty":2}'
    Check-Route -Method POST -Path '/api/orders/1/submit' -Expected 401 -Label 'POST /api/orders/1/submit' -Body '{}'
    Check-Route -Method GET -Path '/api/orders' -Expected 401 -Label 'GET /api/orders'
    Check-Route -Method GET -Path '/api/admin/users' -Expected 401 -Label 'GET /api/admin/users'

    Write-Host ''
    Write-Host '===== 結果 ====='
    Write-Host "  $Passed / $Total passed"
    if ($Passed -eq $Total) {
        Write-Host '  ✅ 全部通過！'
    } else {
        Write-Host "  ❌ 有 $($Total - $Passed) 個測試失敗"
        exit 1
    }
}
finally {
    # 清理：停止後端伺服器
    if ($job) {
        Stop-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -ErrorAction SilentlyContinue
    }
}

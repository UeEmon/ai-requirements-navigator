要件ナビ Docker キット（GitHub で公開しているイメージで動かす）

1. このフォルダで .env.example を .env にコピーする
     Mac:     cp .env.example .env
     Windows: Copy-Item .env.example .env
2. 暗号化の鍵を作り、.env の MASTER_KEY= の行に書き込む
     Windows（PowerShell）:
       $k = docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
       $lines = (Get-Content -Encoding UTF8 .env) -replace '^MASTER_KEY=.*', "MASTER_KEY=$k"
       [IO.File]::WriteAllLines("$PWD\.env", $lines)
     Mac:
       k=$(docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
       sed -i '' "s|^MASTER_KEY=.*|MASTER_KEY=$k|" .env
   確認: MASTER_KEY= の後ろが44文字（最後が =）になっていること
   ※ この鍵は別の安全な場所にも控えること（なくすと登録済みのAPIキーを読めなくなる）
3. 起動する
     docker compose up -d
4. ブラウザで http://localhost:8787 を開く

更新:   docker compose pull  →  docker compose up -d
停止:   docker compose stop   （データは残る）
詳しい手順: https://github.com/UeEmon/ai-requirements-navigator/blob/main/docs/github-deploy.md

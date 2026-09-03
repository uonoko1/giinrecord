# staging のアクセス制限（Cloudflare Access）

Issue #163。`https://staging.giinrecord.jp/` は**運営者だけ**が見られる（決定 2026-08-23、Basic 認証は却下）。
production（`giinrecord.jp`）は誰でも見られ、この文書の設定は一切かからない。

## 全体像

```
ブラウザ ──▶ Cloudflare（DNS プロキシ ON）──▶ Access（メール One-time PIN か Service Token）──▶ VPS のホスト nginx（staging block）
                                                                                              ├─ allow <Cloudflare の IP レンジ>; deny all;   … /etc/nginx/snippets/giinrecord-cloudflare-allow.conf
                                                                                              ├─ Cf-Access-Jwt-Assertion ヘッダが無ければ 403
                                                                                              └─ proxy_pass http://127.0.0.1:8083（web-staging コンテナ）
```

| 層 | 誰が設定 | 何で | 役割 |
|---|---|---|---|
| Cloudflare Access | 人間（ダッシュボード） | この文書の手順 | 本人確認。通った要求にだけ `Cf-Access-Jwt-Assertion` を付けて origin へ |
| IP allow-list | PO（VPS、root） | `deploy/cloudflare-allowlist.sh`（週次 cron） | Cloudflare を経由しない直接アクセス（VPS の IP を直接叩く、`Host: staging.giinrecord.jp` を偽る）を deny |
| ヘッダ検査 | `deploy/vps-setup.sh staging.giinrecord.jp 8083` | staging の 443 `location /` | Cloudflare 経由でも Access を通っていない要求（DNS プロキシを誤って OFF にした等）を 403 |

## Cloudflare 側（人間。すべてダッシュボード、約 10 分）

前提：`giinrecord.jp` のゾーンが Cloudflare にあり、staging の証明書は Let's Encrypt 済み（`deploy/staging-setup.sh`）。

> **改名（gikailog → giinrecord）で残っている手作業**: ダッシュボード上の名前はリポジトリからは変えられない。
> 既存の Access Application は `gikailog staging`、Service Token は `gikailog-monitor` のまま。
> Application 名はその場で改名できる（動作に影響しない）。**Service Token は改名できないので、名前を揃えるなら
> 下の「Service Token のローテーション」の手順で `giinrecord-monitor` を新規発行して差し替える**
> （`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` の更新を伴う）。名前だけの問題なので急がなくてよい。

1. **DNS**：`staging` の A レコードを **Proxied（オレンジ雲）** にする。production の `@` / `www` は当面 DNS only のまま。
2. **SSL/TLS → Overview**：暗号化モード **Full (strict)**。origin は Let's Encrypt の正規証明書なので strict で通る。
   （ゾーン全体の設定。production を後でプロキシ ON にしても同じで良い）
3. **Zero Trust → Access → Applications → Add an application → Self-hosted**
   - Application name: `giinrecord staging`、Session duration: 24 時間程度
   - Application domain: `staging.giinrecord.jp`（パス無し）
   - Identity providers: **One-time PIN** だけ
   - Policy 1: Action **Allow**、Include: **Emails** = 運営者のメールアドレス（必要な人数分）
4. **監視用 Service Token**（`.github/workflows/monitor.yml` が毎時 staging を叩くため）
   - Zero Trust → Access → **Service Auth → Service Tokens → Create**：名前 `giinrecord-monitor`、期限は 1 年
   - 表示される **Client ID / Client Secret** を GitHub の **repository secrets** `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` に
     （Secret は作成時にしか表示されない。どこにも貼らない）
   - アプリの Policy に **Policy 2: Action Service Auth、Include: Service Token = giinrecord-monitor** を追加
5. 確認：シークレットウィンドウで `https://staging.giinrecord.jp/` → Cloudflare のログイン画面 → PIN → サイトが出る。
   `curl -sI https://staging.giinrecord.jp/` は 302（Access のログインへ）。

## VPS 側（PO が実行）

```sh
# 1. Cloudflare の IP レンジ → /etc/nginx/snippets/giinrecord-cloudflare-allow.conf（allow … ; deny all;）＋ 週次 root cron
scp deploy/cloudflare-allowlist.sh "${VPS_SSH_HOST:-sakura-vps}":/tmp/ && \
  ssh "${VPS_SSH_HOST:-sakura-vps}" 'sudo bash /tmp/cloudflare-allowlist.sh --install-cron && rm /tmp/cloudflare-allowlist.sh'
# 2. staging の server block に include と 403 を入れる（冪等。production の conf には触れない）
bash deploy/run-remote.sh deploy/vps-setup.sh staging.giinrecord.jp 8083
```

`deploy/staging-setup.sh` を再実行しても同じことが起きる（step 5 と 8）。`vps-setup.sh` は snippet が無ければ **`deny all;` だけの placeholder**
を書く（fail closed：開放されるのではなく staging が見えなくなる）ので、順序を間違えても production や他サイトには影響しない。

`cloudflare-allowlist.sh` の安全装置：取得した各行が厳密な CIDR 構文でなければ何も書かない（HTML のエラーページや `;` の混入を nginx
設定にしない）、空リストは拒否（Cloudflare 自身を deny してしまう）、同じディレクトリの一時ファイルから rename（原子的）、`nginx -t` が
落ちれば前の snippet に戻して reload しない、内容が同じなら reload しない。cron は `/etc/cron.d/giinrecord-cloudflare-allowlist`（月曜 04:20、
root、`/usr/local/lib/giinrecord-cloudflare-allowlist.sh` = root 所有のコピーを実行。deploy ユーザーが編集できるファイルを root cron が
実行しない）。

確認（VPS 上）：

```sh
sudo nginx -T | grep -A3 'location / {' | grep -B1 -A2 cloudflare        # staging の 443 block だけに include と if がある
curl -sk --resolve staging.giinrecord.jp:443:127.0.0.1 https://staging.giinrecord.jp/ -o /dev/null -w '%{http_code}\n'   # 403（loopback は allow-list 外）
```

## 迂回防止の仕組みと限界（正直に）

- **IP allow-list**：VPS の IP を直接叩いても Cloudflare のレンジ外なので deny（403）。レンジは週次で更新。Cloudflare が
  レンジを増やした直後の最大 1 週間、新レンジからの要求だけが 403 になりうる（監視が `http` で気づく → `cloudflare-allowlist.sh` を手で実行）。
- **`Cf-Access-Jwt-Assertion` の存在チェックのみ**：JWT の署名は検証していない。つまり **Cloudflare のレンジ内から来て、かつこのヘッダを
  付けた要求**は通る。それができるのは理論上「別の Cloudflare 利用者が自分のゾーンの origin をこの VPS に向け、Host を
  `staging.giinrecord.jp` に上書きし（Enterprise 機能）、さらに `Cf-*` ヘッダを注入できた場合」だけで、staging（公開予定の内容の
  プレビュー）の保護としては IP 制限との二重で実用上十分と判断した。厳密な検証（Cloudflare の JWKS で署名と `aud` を検証）が要るなら
  nginx の njs か `cloudflared` トンネル（origin を閉じる）に進む。
- **Authenticated Origin Pulls**（Cloudflare の mTLS）は未設定。共用 VPS のホスト nginx に Cloudflare のクライアント CA を入れる変更は
  他サイトの block に波及しうるので、今はやらない。
- staging の **コンテナ側**（`deploy/nginx/site.conf`、`X-Robots-Tag: noindex`）は変わらない。検索エンジンは Access に弾かれる上に noindex。
- production は完全に無関係：`vps-setup.sh giinrecord.jp 8081` が書く block に include も 403 も無い（`deploy/test/vps-setup.test.sh`、
  `packages/etl/test/deploy-docker.test.ts` が検証）。

## 監視（`.github/workflows/monitor.yml` の staging job）

- `deploy/monitor/probe.sh` は `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` があると `CF-Access-Client-Id` / `CF-Access-Client-Secret`
  ヘッダを付ける。値は **curl の設定ファイル（mode 600、終了時に削除）経由**で渡し、argv（`ps`、Actions のログ）にも出力にも出ない。
- secrets が無いときは `deploy/monitor/run.sh`（`MONITOR_REQUIRE_CF_ACCESS=1`）が `::warning::` を出して **probe をスキップ、exit 0**。
  ログイン画面の 302 を「http 失敗」として誤報しないため。Issue の作成も close もしない。
- `tls` check は Cloudflare のエッジ証明書の期限を見る（ブラウザが見るものと同じ）。origin の Let's Encrypt 証明書の期限は VPS 側の
  `certbot renew` の timer と `[monitor] vps: nginx` に頼る。Full (strict) なので origin の証明書が切れると `http` が 5xx で落ちて気づく。

## Service Token のローテーション（1 年ごと、または漏洩時）

1. Zero Trust → Access → Service Auth → Service Tokens → **Create**（新トークン `giinrecord-monitor-YYYYMM`）
2. アプリの Service Auth ポリシーに新トークンを**追加**（旧トークンはまだ残す）
3. GitHub repository secrets `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` を新しい値に更新
4. Actions → Monitor → **Run workflow** で staging job が green（`::warning::` 無し）なのを確認
5. 旧トークンをポリシーから外し、**Revoke**
漏洩時は 5 を先にやる（監視は次の定期実行まで `http` で失敗する。それで良い）。

運営者のメール変更・追加は Policy 1 の Emails を編集するだけ。退任時は外す（セッションは最長 24 時間で切れる）。

## 変えるとき

- 許可する人を増やす：Policy 1 の Emails。リポジトリには**メールアドレスを書かない**。
- production も Cloudflare 経由にする：DNS を Proxied にするだけ。allow-list / 403 は staging block にしか無いので production は開放のまま。
  production に allow-list を入れたくなったら `vps-setup.sh` の `cf_gate_lines` を変える前に Issue を立てる（決定事項）。
- Access を外す：アプリを削除し、`vps-setup.sh` の `cf_gate_lines` から 403 行を外す PR。allow-list だけ残す場合は DNS は Proxied のまま。

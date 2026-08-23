# LB Discord RPC

ListenBrainzのNowPlayingをポーリングしてPC上のDiscordデスクトップクライアントにRichPresenceとして反映します

## セットアップ

1. https://discord.com/developers/applications でアプリケーションを作成し、Application IDを控える
2. （任意）Rich Presence > Art Assets に `listenbrainz_logo` / `listenbrainz_icon` という名前で画像をアップロードすると、カバー画像が取得できなかったときにフォールバックでここに設定したアイコンが出る
3. Discordデスクトップアプリを起動しておく

必要パッケージのインストール  
```
npm install
```

起動
```
DISCORD_CLIENT_ID=あなたのApplication ID \
LB_USERNAME=あなたのListenBrainzユーザー名 \
LB_TOKEN=あなたのListenBrainzユーザートークン \
npm start
```

`LB_TOKEN`は https://listenbrainz.org/settings/ の「User Token」から取得できる（ジャケット画像検索に使う`/1/metadata/lookup/`エンドポイントが認証必須のため）。

環境変数は以下の通り（`POLL_INTERVAL_MS`は任意、デフォルト15000ms）:

| 変数 | 内容 |
|---|---|
| `DISCORD_CLIENT_ID` | DiscordアプリケーションのID（必須） |
| `LB_USERNAME` | ListenBrainzのユーザー名（必須） |
| `LB_TOKEN` | ListenBrainzのユーザートークン（ジャケット画像検索に必須。未設定でも動くがジャケットは常に既定ロゴになる） |
| `POLL_INTERVAL_MS` | ポーリング間隔ms（省略可、デフォルト15000） |

## ジャケット画像について

`playing-now`エンドポイントの返り値には基本的にMusicBrainzへのマッチング情報 (`mbid_mapping`)が載らない（一時的な再生中通知はマッピング処理を通らないため）。  
そのため曲が変わるたびに`/1/metadata/lookup/`で曲名+アーティスト名から改めてMusicBrainzへの自動マッチングを引き直し、そこで得られる`caa_id`/`caa_release_mbid`からCover Art ArchiveのURLを組み立てて使っている。  
マッチしなかった曲や、Cover Art Archiveに画像が無いリリースは既定のロゴ(`listenbrainz_logo`アセット)にフォールバックする。  
結果は曲ごとにメモリ上でキャッシュするので、同じ曲の再生中は毎tickで検索し直さない。

## 表示形式について

Discordの一番上の太字行（通常「Playing 〜」と出る部分）は、local RPCの仕様上DiscordアプリケーションのIDに紐づく固定の名前が使われ、曲ごとに動的に書き換えることはできない（曲名にするには、DiscordのGatewayに直接ユーザーのアカウントで接続するセルフBot的な手法が必要で、これは利用規約に触れるため未実装）。

代わりに`type: 2`(Listening)を指定して「Listening to <アプリ名>」という表示にしている。  
アプリ名を「ListenBrainz」のような分かりやすい名前にしたい場合は、 https://discord.com/developers/applications の該当アプリの「General Information」から名前を変更できる（曲ごとの自動変更ではなく、手動での固定名変更）。

## 進捗表示について

Discordのプロフィール上でSpotifyだけに出る「クリックしてシークできるバー」はSpotify連携専用の機能で、サードパーティのRPCでは出せない。  
代わりに`startTimestamp`/`endTimestamp`の両方を設定することで「経過時間 / 残り時間」のカウンター表示ができるので、そちらを使っている。

曲の長さは、優先順位で以下から取得する:

1. ListenBrainzの`playing-now`にスクロブラーが`duration_ms`(または`duration`)を送ってくれている場合、それをそのまま使う（追加の通信不要）
2. 上記が無い場合、ジャケット検索時に得られる`recording_mbid`を使ってMusicBrainzの`/ws/2/recording/{mbid}`から曲の長さを取得する

どちらも取れない曲は経過/残り時間の表示なし（ジャケット・曲名などは通常通り表示）。

再生検出のタイミングを「再生開始」とみなして`startTimestamp`を打つため、ポーリング間隔（デフォルト15秒）ぶんの誤差が出うる点は留意。

## 注意点

- PCがスリープしている間、またはDiscordデスクトップを閉じている間はRPCが反映されない
- ListenBrainzの`playing-now`は、last.fm連携などのスクロブラーが有効になっている
  必要がある
- 常駐させたい場合は pm2 / systemd（`--user`サービス）などでバックグラウンド常駐化すると良い

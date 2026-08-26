// lb-discord-rpc
// PC単体で、ListenBrainzのNowPlayingをポーリングして
// Discordデスクトップクライアントに直接RichPresenceとして反映する。

const RPC = require("discord-rpc");

// ==== 設定 ====
// https://discord.com/developers/applications で作成したアプリのID
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "YOUR_DISCORD_APPLICATION_ID";

// ListenBrainzのユーザー名
const LB_USERNAME = process.env.LB_USERNAME || "your-listenbrainz-username";

// ListenBrainzのユーザートークン（https://listenbrainz.org/settings/ で取得）
// /1/metadata/lookup/ エンドポイントの呼び出しに必須
const LB_TOKEN = process.env.LB_TOKEN || "";

// 曲の長さが分からない時のフォールバック・ポーリング間隔（ミリ秒）
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);

// 曲の長さが分かっている時の適応ポーリングの下限・上限（ミリ秒）
const MIN_POLL_INTERVAL_MS = Number(process.env.MIN_POLL_INTERVAL_MS || 5000);
const MAX_POLL_INTERVAL_MS = Number(process.env.MAX_POLL_INTERVAL_MS || 45000);

// 曲の終了予定時刻ちょうどではなく、少し過ぎたタイミングで確認する猶予（ミリ秒）
const END_BUFFER_MS = 2000;

// 何ms更新が来なかったらPresenceを消すか
const STALE_TIMEOUT_MS = 60 * 1000;

// ListenBrainz/Cover Art Archiveでジャケットが見つからなかった時に
// iTunes/Deezerへフォールバック検索するかどうか（"false"で無効化）
const COVER_FALLBACK_ENABLED =
  (process.env.COVER_FALLBACK_ENABLED ?? "true") !== "false";

// 曲ごとのメタ情報探索結果のキャッシュ（曲が変わるたびに毎回引き直さないため）
const trackMetaCache = new Map();

// ==== Discord RPC接続 ====
RPC.register(CLIENT_ID);
const rpc = new RPC.Client({ transport: "ipc" });
let rpcReady = false;

function connectRpc() {
  rpc.login({ clientId: CLIENT_ID }).catch((err) => {
    console.error(
      "[discord-rpc] ログイン失敗（Discordデスクトップが起動しているか確認）:",
      err.message
    );
    setTimeout(connectRpc, 5000);
  });
}

rpc.on("ready", () => {
  rpcReady = true;
  console.log("[discord-rpc] 接続しました。ユーザー:", rpc.user?.username);
  startPolling();
});

rpc.transport.on("close", () => {
  rpcReady = false;
  console.warn("[discord-rpc] 接続が切れました。再接続します...");
  setTimeout(connectRpc, 5000);
});

connectRpc();

/**
 * discord-rpcパッケージのsetActivity()は`type`フィールドを送ってくれないため、
 * SET_ACTIVITYコマンドを直接叩いてtype: 2(Listening)を指定する。
 * これでDiscord側の表示が「Listening to <アプリ名>」になる
 * （アプリ名自体を曲名に動的に変えることはlocal RPCの仕様上できない）。
 */
function setListeningActivity({
  details,
  state,
  largeImageKey,
  largeImageText,
  smallImageKey,
  smallImageText,
  startTimestamp,
  endTimestamp,
  trackUrl,
}) {
  return rpc.request("SET_ACTIVITY", {
    pid: process.pid,
    activity: {
      type: 2, // 0: Playing, 2: Listening, 3: Watching, 5: Competing
      details,
      state,
      assets: {
        large_image: largeImageKey,
        large_text: largeImageText,
        small_image: smallImageKey,
        small_text: smallImageText,
      },
      // start/endを両方入れると「経過時間 / 残り時間」のカウンター表示になる
      // (Spotify連携のようなクリックしてシークできるバーは third-party RPC では出せない)
      timestamps:
        startTimestamp && endTimestamp
          ? { start: startTimestamp, end: endTimestamp }
          : undefined,
      // クリックでListenBrainzのトラックページに飛べるボタン
      // （自分のプロフィール画面には出ない仕様。他人から見た時だけ表示される）
      buttons: trackUrl
        ? [{ label: "ListenBrainzで開く", url: trackUrl }]
        : undefined,
      instance: false,
    },
  });
}

// ==== ListenBrainzポーリング ====
let lastKey = null;
let staleTimer = null;
let pollTimer = null;
// 今再生中と思われる曲の終了予定時刻（曲の長さが分かっている時だけセットされる）
let currentEndTimestamp = null;

function resetStaleTimer() {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(async () => {
    if (rpcReady && lastKey) {
      await rpc.clearActivity().catch(() => {});
      lastKey = null;
      console.log("[lb] 更新が途絶えたためPresenceをクリアしました");
    }
  }, STALE_TIMEOUT_MS);
}

/** 曲名/アーティスト名末尾の「(リミックス)」「(feat.〜)」等の括弧書きを取り除く。 */
function stripParenthetical(str) {
  return str.replace(/[\(（][^)）]*[\)）]\s*$/u, "").trim();
}

/** 「A、B、C」「A / B」「A feat. B」のような複数アーティスト表記から先頭だけ取り出す。 */
function firstArtist(str) {
  return str
    .split(/[,、\/×&]|feat\.?|ft\.?| with /iu)[0]
    .trim();
}

/** 重複を除きつつ、試す価値のある(artist, track, release)候補を順番に作る。 */
function buildLookupCandidates(artist, track, album) {
  const strippedTrack = stripParenthetical(track);
  const strippedArtist = stripParenthetical(artist);
  const soleArtist = firstArtist(strippedArtist || artist);

  const candidates = [
    { artist, track, album }, // そのまま(アルバム込み)
    { artist, track, album: null }, // アルバム抜き
    { artist: strippedArtist, track: strippedTrack, album: null }, // 括弧書き除去
    { artist: soleArtist, track: strippedTrack, album: null }, // 先頭アーティストのみ
  ];

  // 重複排除
  const seen = new Set();
  return candidates.filter((c) => {
    if (!c.artist || !c.track) return false;
    const key = `${c.artist}|${c.track}|${c.album}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** ListenBrainzの /1/metadata/lookup/ を1回叩き、caa情報とrecording_mbidを返す。 */
async function lookupOnce(artist, track, album) {
  const params = new URLSearchParams({
    artist_name: artist,
    recording_name: track,
    metadata: "true",
    inc: "release",
  });
  if (album) params.set("release_name", album);

  const res = await fetch(
    `https://api.listenbrainz.org/1/metadata/lookup/?${params}`,
    { headers: { Authorization: `Token ${LB_TOKEN}` } }
  );

  if (!res.ok) {
    console.warn(`[lb] metadata/lookup失敗: HTTP ${res.status}`);
    return null;
  }

  const json = await res.json();
  const release = json.metadata?.release;
  const coverUrl =
    release?.caa_id && release?.caa_release_mbid
      ? `https://coverartarchive.org/release/${release.caa_release_mbid}/${release.caa_id}-250.jpg`
      : null;

  return { coverUrl, recordingMbid: json.recording_mbid || null };
}

/**
 * iTunes Search APIからジャケット画像を検索する（APIキー不要）。
 * 返ってくるartworkUrl100は100x100の小さい画像なので、600x600に置換して使う。
 */
async function fetchCoverFromItunes(artist, track) {
  try {
    const params = new URLSearchParams({
      term: `${artist} ${track}`,
      media: "music",
      entity: "song",
      limit: "1",
    });
    const res = await fetch(`https://itunes.apple.com/search?${params}`);
    if (!res.ok) return null;
    const json = await res.json();
    const artwork = json.results?.[0]?.artworkUrl100;
    return artwork ? artwork.replace("100x100bb", "600x600bb") : null;
  } catch (err) {
    console.warn("[cover] iTunes検索エラー:", err.message);
    return null;
  }
}

/**
 * Deezerの検索APIからジャケット画像を探す（APIキー不要、iTunesでも
 * 見つからなかった時のさらなるフォールバック）。
 */
async function fetchCoverFromDeezer(artist, track) {
  try {
    const params = new URLSearchParams({
      q: `artist:"${artist}" track:"${track}"`,
    });
    const res = await fetch(`https://api.deezer.com/search?${params}`);
    if (!res.ok) return null;
    const json = await res.json();
    const album = json.data?.[0]?.album;
    return album?.cover_xl || album?.cover_big || album?.cover_medium || null;
  } catch (err) {
    console.warn("[cover] Deezer検索エラー:", err.message);
    return null;
  }
}

/**
 * ListenBrainz/Cover Art Archiveでジャケットが見つからなかった曲について、
 * iTunes → Deezerの順に外部ソースからジャケット画像を探す。
 * どちらもヒットしなければnullを返し、呼び出し側で既定ロゴにフォールバックする。
 */
async function fetchCoverFallback(artist, track) {
  if (!COVER_FALLBACK_ENABLED) return null;

  const itunes = await fetchCoverFromItunes(artist, track);
  if (itunes) {
    console.log("[cover] iTunesでジャケット取得");
    return itunes;
  }

  const deezer = await fetchCoverFromDeezer(artist, track);
  if (deezer) {
    console.log("[cover] Deezerでジャケット取得");
    return deezer;
  }

  return null;
}

/** MusicBrainzのrecordingエンドポイントから曲の長さ(ms)を取得する。 */
async function fetchRecordingLength(recordingMbid) {
  if (!recordingMbid) return null;
  try {
    const res = await fetch(
      `https://musicbrainz.org/ws/2/recording/${recordingMbid}?fmt=json`,
      { headers: { "User-Agent": "lb-discord-rpc/1.0 ( personal use )" } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json.length === "number" ? json.length : null;
  } catch (err) {
    console.warn("[lb] MusicBrainz recording取得エラー:", err.message);
    return null;
  }
}

/**
 * 曲名+アーティスト名からListenBrainzの /1/metadata/lookup/ を叩き、
 * MusicBrainzへの自動マッチング結果からCover Art ArchiveのURLと曲の長さを取得する。
 * そのままの表記でマッチしない場合、アルバム抜き・括弧書き除去・アーティスト単体化
 * の順に条件を緩めて再試行する。
 * @param {number|null} knownDurationMs ListenBrainz側から既に分かっている曲の長さ(ms)。
 *   これがあればMusicBrainzへの追加問い合わせをスキップする。
 * @returns {Promise<{coverUrl: string|null, durationMs: number|null, recordingMbid: string|null}>}
 */
async function resolveTrackMeta(artist, track, album, knownDurationMs) {
  const cacheKey = `${artist}|${track}|${album}`;
  if (trackMetaCache.has(cacheKey)) return trackMetaCache.get(cacheKey);

  let coverUrl = null;
  let recordingMbid = null;
  let durationMs = knownDurationMs || null;

  if (!LB_TOKEN) {
    console.warn("[lb] LB_TOKEN未設定のためジャケット画像の検索をスキップします");
  } else {
    const candidates = buildLookupCandidates(artist, track, album);
    for (const c of candidates) {
      let hit = null;
      try {
        hit = await lookupOnce(c.artist, c.track, c.album);
      } catch (err) {
        console.warn("[lb] ジャケット画像検索エラー:", err.message);
      }
      if (hit?.coverUrl) {
        coverUrl = hit.coverUrl;
        console.log(`[lb] ジャケット検索ヒット: "${c.artist}" - "${c.track}"`);
      }
      if (hit?.recordingMbid) {
        recordingMbid = hit.recordingMbid;
      }
      // 曲の長さがまだ分かっていなければMusicBrainzから補完する
      if (!durationMs && hit?.recordingMbid) {
        durationMs = await fetchRecordingLength(hit.recordingMbid);
      }
      if (coverUrl && durationMs) break;
      if (hit) break; // マッチ自体はしたので、これ以上緩い条件では試さない
    }
  }

  // ListenBrainz/CAAで見つからなかった場合、iTunes/Deezerへフォールバック検索する
  if (!coverUrl) {
    coverUrl = await fetchCoverFallback(artist, track);
  }

  const result = { coverUrl, durationMs, recordingMbid };
  trackMetaCache.set(cacheKey, result);
  return result;
}

async function fetchNowPlaying() {
  const url = `https://api.listenbrainz.org/1/user/${LB_USERNAME}/playing-now`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ListenBrainz API error: HTTP ${res.status}`);
  const json = await res.json();

  const count = json.payload?.count ?? 0;
  if (count <= 0) return null;

  const meta = json.payload.listens?.[0]?.track_metadata;
  if (!meta) return null;

  const artist = meta.artist_name || "";
  const track = meta.track_name || "";
  const album = meta.release_name || null;
  if (!artist || !track) return null;

  // スクロブラーが送ってくれていれば曲の長さが既に分かる（MusicBrainzへの追加問い合わせ不要）
  const additionalInfo = meta.additional_info || {};
  const durationMs =
    additionalInfo.duration_ms ??
    (additionalInfo.duration ? additionalInfo.duration * 1000 : null);

  return { artist, track, album, durationMs };
}

async function tick() {
  try {
    const np = await fetchNowPlaying();

    if (!np) {
      if (lastKey && rpcReady) {
        await rpc.clearActivity().catch(() => {});
        lastKey = null;
        console.log("[lb] 再生停止中");
      }
      currentEndTimestamp = null;
      return;
    }

    const key = `${np.artist}|${np.track}|${np.album}`;
    if (key !== lastKey && rpcReady) {
      // 曲が変わった時だけメタ情報(ジャケット・曲の長さ・MBID)を探しに行く（毎tickでは叩かない）
      const { coverUrl, durationMs, recordingMbid } = await resolveTrackMeta(
        np.artist,
        np.track,
        np.album,
        np.durationMs
      );

      // 曲の長さが分かれば、経過/残り時間のカウンター表示用にstart/endを設定する
      // （検出したタイミング=再生開始とみなすので、ポーリング間隔ぶんのズレは出うる）
      let startTimestamp;
      let endTimestamp;
      if (durationMs) {
        startTimestamp = Date.now();
        endTimestamp = startTimestamp + durationMs;
      }
      currentEndTimestamp = endTimestamp || null;

      const trackUrl = recordingMbid
        ? `https://listenbrainz.org/player/?recording_mbids=${recordingMbid}`
        : null;

      await setListeningActivity({
        details: np.track,
        state: `by ${np.artist}${np.album ? " - " + np.album : ""}`,
        // ジャケット画像が取れた場合はそれを、取れなければ既定のロゴにフォールバック
        largeImageKey: coverUrl || "listenbrainz_logo",
        largeImageText: np.album || "ListenBrainz",
        smallImageKey: "listenbrainz_icon",
        smallImageText: "Listening via ListenBrainz",
        startTimestamp,
        endTimestamp,
        trackUrl,
      });
      lastKey = key;
      console.log(
        `[lb] Presence更新: ${np.artist} - ${np.track}` +
          `${coverUrl ? " (ジャケット取得)" : " (ジャケット無し)"}` +
          `${durationMs ? ` (${Math.round(durationMs / 1000)}秒)` : " (長さ不明)"}`
      );
    }
    resetStaleTimer();
  } catch (err) {
    console.error("[lb] エラー:", err.message);
  }
}

/**
 * 次にポーリングするまでの待ち時間を計算する。
 * 曲の終了予定時刻が分かっていれば「終わりそうなタイミングの少し後」を狙い、
 * 分からなければ既定のPOLL_INTERVAL_MSを使う。
 * 上下限(MIN/MAX_POLL_INTERVAL_MS)でクランプし、極端に短い/長い待ちを避ける
 * （長すぎる待ちにしないのは、途中でスキップされた場合になるべく早く気付くため）。
 */
function computeNextDelay() {
  if (!currentEndTimestamp) return POLL_INTERVAL_MS;

  const remaining = currentEndTimestamp - Date.now() + END_BUFFER_MS;
  return Math.min(Math.max(remaining, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
}

async function scheduleNext() {
  await tick();
  const delay = computeNextDelay();
  console.log(`[lb] 次回ポーリングまで ${Math.round(delay / 1000)}秒`);
  pollTimer = setTimeout(scheduleNext, delay);
}

function startPolling() {
  if (pollTimer) return;
  scheduleNext();
}

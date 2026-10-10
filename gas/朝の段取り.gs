/**
 * 朝の段取り（毎朝のLINE通知）
 * ------------------------------------------------------------
 * 毎朝5時台に、その日の段取りを1通のLINEにまとめて送ります。
 *   🌤 今日・明日の天気（降水確率・気温・風）
 *   ⚠️ 警報・注意報（気象庁）
 *   💡 天気から見た段取りのヒント（雨・風・暑さ・霜）
 *   🧴 防除予定 ／ 🧑‍🌾 作業予定（今日の分と遅れている分）
 *   📄 今日・明日の作業書
 *   🌾 収穫中・まもなく収穫
 *   📝 やることメモ（期限すぎ・今日・その他）
 *   📦 要発注の資材（発注リスト.gs の発注点設定から）
 *
 * データは、アプリと同じ GAS の API（forecast / jmaWarning / listPlan / listWorkPlan /
 * listSagyosho / listPlanting / listTodo / listStock / listFert）から取得します。
 * 既存の関数・シートには手を入れません。
 *
 * 【初回の設定】
 *  1. このファイルと「発注リスト.gs」をGASに追加して保存
 *  2. 関数「previewMorning」を実行 → 実行ログに文面が出ることを確認
 *  3. 関数「testMorningBrief」を実行 → LINEに届くことを確認
 *  4. 関数「setupMorningTrigger」を実行 → 毎朝5時台の自動送信が始まります
 *  ※ やることメモの毎朝6時の通知は、内容がこちらに含まれるので止めてもOKです（重複防止）
 *
 * 【スクリプトプロパティ（必要に応じて）】
 *  LINE のトークン … 既存のプロパティ名（LINE_TOKEN / LINE_CHANNEL_ACCESS_TOKEN など）を自動で探します
 *  MORNING_TO     … 送信先（userId または groupId。カンマ区切りで複数可）。未設定ならあにきさんのみ
 *  APP_GAS_URL    … このGASのウェブアプリURL（未設定なら現在のURLを使用）
 */

var MORNING_APP_URL = 'https://t244t.github.io/nouyaku-app/';
var MORNING_DEFAULT_TO = 'Uf760e5551fafc369a0a2527dc30cf563';
var MORNING_GAS_URL = 'https://script.google.com/macros/s/AKfycbzrKD24LhH_AKetCGNIAHvAFv44EaJIzDMOUI6YFVskY9W2dJj1aBOjW1Im3RBAZfqR/exec';
var MORNING_HOUR = 5;
var MORNING_TOKEN_KEYS = ['LINE_TOKEN', 'LINE_CHANNEL_ACCESS_TOKEN', 'CHANNEL_ACCESS_TOKEN', 'LINE_ACCESS_TOKEN', 'ACCESS_TOKEN', 'TOKEN'];

/* ========== トリガーから呼ばれる本体 ========== */
function morningBrief() {
  var text = buildMorningText_();
  pushMorning_(text);
}

/* ========== 手動実行用 ========== */
function previewMorning() {
  Logger.log(buildMorningText_());
}

function testMorningBrief() {
  var text = buildMorningText_();
  Logger.log(text);
  pushMorning_(text);
}

function setupMorningTrigger() {
  stopMorningTrigger();
  ScriptApp.newTrigger('morningBrief').timeBased().everyDays(1).atHour(MORNING_HOUR).inTimezone('Asia/Tokyo').create();
  Logger.log('毎朝' + MORNING_HOUR + '時台に「朝の段取り」を送る設定をしました。');
}

function stopMorningTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'morningBrief') ScriptApp.deleteTrigger(t);
  });
}

function sendMorningNow_() {
  try { pushMorning_(buildMorningText_()); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/* ========== 文面づくり ========== */
function buildMorningText_() {
  var now = new Date();
  var td = jstDate_(now);
  var tm = jstDate_(new Date(now.getTime() + 86400000));
  var dow = '日月火水木金土'.charAt(Number(Utilities.formatDate(now, 'Asia/Tokyo', 'u')) % 7);
  var md = function (s) { var m = String(s || '').match(/^\d{4}-(\d{1,2})-(\d{1,2})/); return m ? (Number(m[1]) + '/' + Number(m[2])) : String(s || ''); };

  // ---- データ取得（失敗しても他は続ける） ----
  var fc = apiSelf_({ action: 'forecast' });
  var warn = apiSelf_({ action: 'jmaWarning' });
  var plans = pick_(apiSelf_({ action: 'listPlan', 状態: '予定' }), 'plans');
  var wplans = pick_(apiSelf_({ action: 'listWorkPlan', 状態: '予定' }), 'plans');
  var docs = pick_(apiSelf_({ action: 'listSagyosho' }), 'items');
  var plantings = pick_(apiSelf_({ action: 'listPlanting' }), 'plantings');
  var todos = pick_(apiSelf_({ action: 'listTodo' }), 'items');
  var stock = pick_(apiSelf_({ action: 'listStock' }), 'stock');
  var fert = pick_(apiSelf_({ action: 'listFert' }), 'fert');

  var L = [];
  L.push('☀️ おはようございます');
  L.push(md(td) + '（' + dow + '）の段取りです');

  // ---- 天気 ----
  var d = fc && fc.daily;
  var wxT = null, wxM = null;
  if (d && d.time && d.time.length) {
    var iT = dayIndex_(d.time, td), iM = dayIndex_(d.time, tm);
    if (iT < 0) iT = 0;
    wxT = dayWx_(d, iT);
    if (iM >= 0) wxM = dayWx_(d, iM);
    L.push('');
    L.push('🌤 天気（糸島）');
    L.push('今日　' + wxLine_(wxT));
    if (wxM) L.push('明日　' + wxLine_(wxM));
  }

  // ---- 警報・注意報 ----
  if (warn && warn.ok && warn.warnings && warn.warnings.length) {
    var names = warn.warnings.map(function (w) { return w.name; });
    L.push('');
    L.push('⚠️ 警報・注意報（福岡県内）');
    L.push(names.join('・'));
  }

  // ---- 予定（今日＋遅れ） ----
  var spT = plans.filter(function (p) { return String(p['予定日']).slice(0, 10) === td; });
  var spO = plans.filter(function (p) { var x = String(p['予定日']).slice(0, 10); return x && x < td; });
  var wkT = wplans.filter(function (p) { return String(p['予定日']).slice(0, 10) === td; });
  var wkO = wplans.filter(function (p) { var x = String(p['予定日']).slice(0, 10); return x && x < td; });

  // ---- 段取りのヒント ----
  var tips = [];
  if (wxT) {
    if (wxT.prob != null && wxT.prob >= 50) {
      if (spT.length) tips.push('☔ 雨の予報（' + wxT.prob + '%）。今日の防除は延期を検討');
      tips.push('☔ 雨の前に、収穫・出荷は午前中に');
    }
    if (spT.length && wxT.wind != null && wxT.wind >= 5) tips.push('🌬 風' + wxT.wind + 'm/s。防除は風の弱い時間に、ドリフトに注意');
    else if (wxT.wind != null && wxT.wind >= 10) tips.push('🌬 強風（' + wxT.wind + 'm/s）。ネット・マルチ・資材の飛散に注意');
    if (wxT.tmax != null && wxT.tmax >= 33) tips.push('🥵 猛暑（最高' + wxT.tmax + '℃）。作業は朝夕に、こまめに休憩と水分を');
    else if (wxT.tmax != null && wxT.tmax >= 30) tips.push('💧 暑くなります（最高' + wxT.tmax + '℃）。水分補給を忘れずに');
    if (wxT.tmin != null && wxT.tmin <= 3) tips.push('🥶 冷え込み（最低' + wxT.tmin + '℃）。霜に注意、被覆資材の確認を');
  }
  if (wxM && wxM.prob != null && wxM.prob >= 70 && !(wxT && wxT.prob >= 50)) tips.push('🌂 明日は雨の予報（' + wxM.prob + '%）。外の作業は今日のうちに');
  if (tips.length) { L.push(''); L.push('💡 段取りのヒント'); tips.forEach(function (t) { L.push(t); }); }

  // ---- 防除予定 ----
  if (spT.length || spO.length) {
    L.push('');
    L.push('🧴 防除予定');
    spO.concat(spT).slice(0, 6).forEach(function (p) {
      var late = String(p['予定日']).slice(0, 10) < td;
      L.push('・' + (late ? '【遅れ ' + md(p['予定日']) + '】' : '') + [p['品目'], p['対象']].filter(String).join('／') + '　' + (p['農薬名'] || ''));
    });
  }

  // ---- 作業予定 ----
  if (wkT.length || wkO.length) {
    L.push('');
    L.push('🧑‍🌾 作業予定');
    wkO.concat(wkT).slice(0, 8).forEach(function (p) {
      var late = String(p['予定日']).slice(0, 10) < td;
      L.push('・' + (late ? '【遅れ ' + md(p['予定日']) + '】' : '') + [p['圃場'], p['カテゴリ']].filter(String).join('／') + '　' + (p['作業内容'] || ''));
    });
  }

  // ---- 作業書 ----
  var docT = [], docM = [];
  docs.forEach(function (x) {
    var o = x.data || {};
    if (x.status === '完了') return;
    var line = (o.kenmei || '（件名なし）') + ((o.places && o.places.length) ? '　📍' + o.places.map(function (p) { return p.basho; }).filter(String).join('・') : '');
    if (o.date === td) docT.push(line);
    else if (o.date === tm) docM.push(line);
  });
  if (docT.length || docM.length) {
    L.push('');
    L.push('📄 作業書');
    docT.forEach(function (s) { L.push('・今日　' + s); });
    docM.forEach(function (s) { L.push('・明日　' + s); });
  }

  // ---- 収穫 ----
  var harvNow = [], harvSoon = [];
  plantings.forEach(function (p) {
    var hs = String(p['収穫開始'] || '').slice(0, 10), he = String(p['収穫終了'] || '').slice(0, 10) || hs;
    if (!hs) return;
    var label = (p['圃場'] ? p['圃場'] + 'の' : '') + (p['作物'] || '');
    if (td >= hs && td <= he) harvNow.push(label);
    else if (td < hs) {
      var days = Math.round((new Date(hs + 'T00:00:00+09:00') - new Date(td + 'T00:00:00+09:00')) / 86400000);
      if (days <= 7) harvSoon.push(label + '（あと' + days + '日）');
    }
  });
  if (harvNow.length || harvSoon.length) {
    L.push('');
    L.push('🌾 収穫');
    if (harvNow.length) L.push('収穫中：' + harvNow.join('・'));
    if (harvSoon.length) L.push('まもなく：' + harvSoon.join('・'));
  }

  // ---- やることメモ ----
  var open = todos.filter(function (t) { return t['状態'] !== '済'; });
  if (open.length) {
    var over = open.filter(function (t) { return t['期限'] && t['期限'] < td; });
    var today = open.filter(function (t) { return t['期限'] === td; });
    var rest = open.filter(function (t) { return !t['期限'] || t['期限'] > td; });
    L.push('');
    L.push('📝 やることメモ（' + open.length + '件）');
    over.forEach(function (t) { L.push('・【期限すぎ】' + todoLine_(t)); });
    today.forEach(function (t) { L.push('・【今日】' + todoLine_(t)); });
    rest.slice(0, Math.max(0, 6 - over.length - today.length)).forEach(function (t) { L.push('・' + todoLine_(t)); });
  }

  // ---- 要発注 ----
  try {
    var rs = reorderStatus_(stock, fert);
    if (rs.need.length || rs.waiting.length) {
      L.push('');
      L.push('📦 資材の発注');
      rs.need.forEach(function (m) {
        L.push('・【要発注】' + m.name + '　残り' + m.qty + m.unit +
          (m.amount ? ' → ' + m.amount + (/\d$/.test(m.amount) ? m.unit : '') : '') +
          (m.supplier ? '（' + m.supplier + '）' : ''));
      });
      rs.waiting.forEach(function (m) { L.push('・【入荷待ち】' + m.name + '（' + md(m.ordered) + ' 発注）'); });
    }
  } catch (e) { /* 発注設定が無くても朝の段取りは送る */ }

  if (!spT.length && !spO.length && !wkT.length && !wkO.length && !docT.length && !open.length) {
    L.push('');
    L.push('📋 今日の予定は登録されていません');
  }

  L.push('');
  L.push('今日もご安全に🌱');
  L.push('▶ アプリを開く ' + MORNING_APP_URL);
  return L.join('\n');
}

/* ========== 補助 ========== */
function apiSelf_(params) {
  var base = PropertiesService.getScriptProperties().getProperty('APP_GAS_URL') || MORNING_GAS_URL;
  var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  try {
    var r = UrlFetchApp.fetch(base + '?' + qs, { muteHttpExceptions: true, followRedirects: true });
    if (r.getResponseCode() !== 200) return null;
    return JSON.parse(r.getContentText());
  } catch (e) {
    Logger.log('取得失敗 ' + params.action + ': ' + e);
    return null;
  }
}

function pick_(j, key) {
  return (j && j[key] && j[key].length) ? j[key] : [];
}

function dayIndex_(times, ymd) {
  for (var i = 0; i < times.length; i++) if (String(times[i]).slice(0, 10) === ymd) return i;
  return -1;
}

function dayWx_(d, i) {
  var g = function (k) { var a = d[k]; return (a && a[i] != null && !isNaN(a[i])) ? Number(a[i]) : null; };
  var r = function (v) { return v == null ? null : Math.round(v); };
  return { precip: g('precip'), prob: r(g('precip_prob')), tmax: r(g('tmax')), tmin: r(g('tmin')), wind: r(g('wind')), snow: g('snow') };
}

function wxLine_(w) {
  var icon = '☀️';
  if (w.snow != null && w.snow > 0) icon = '⛄';
  else if ((w.prob != null && w.prob >= 60) || (w.precip != null && w.precip >= 5)) icon = '☔';
  else if ((w.prob != null && w.prob >= 30) || (w.precip != null && w.precip >= 1)) icon = '☁️';
  var s = icon + ' ';
  if (w.tmax != null) s += w.tmax + '℃';
  if (w.tmin != null) s += '/' + w.tmin + '℃';
  s += '　☂' + (w.prob != null ? w.prob : '–') + '%';
  if (w.wind != null) s += '　風' + w.wind + 'm/s';
  return s;
}

function todoLine_(t) {
  return (t['内容'] || '') + (t['圃場'] ? '（' + t['圃場'] + '）' : '');
}

function lineToken_() {
  var props = PropertiesService.getScriptProperties();
  for (var i = 0; i < MORNING_TOKEN_KEYS.length; i++) {
    var v = props.getProperty(MORNING_TOKEN_KEYS[i]);
    if (v) return v;
  }
  throw new Error('LINEのトークンが見つかりません。スクリプトプロパティ「LINE_TOKEN」にチャネルアクセストークンを登録してください。' +
    '（今あるプロパティ名：' + Object.keys(props.getProperties()).join(', ') + '）');
}

function pushMorning_(text) {
  var token = lineToken_();
  var toProp = PropertiesService.getScriptProperties().getProperty('MORNING_TO');
  var targets = String(toProp || MORNING_DEFAULT_TO).split(',').map(function (s) { return s.trim(); }).filter(String);

  // LINEの1メッセージは5000文字まで。長いときは分割（最大5通）
  var chunks = [], buf = '';
  text.split('\n').forEach(function (line) {
    if ((buf + '\n' + line).length > 4800) { chunks.push(buf); buf = line; }
    else buf = buf ? buf + '\n' + line : line;
  });
  if (buf) chunks.push(buf);
  var messages = chunks.slice(0, 5).map(function (c) { return { type: 'text', text: c }; });

  targets.forEach(function (to) {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: to, messages: messages }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('LINE送信エラー（' + res.getResponseCode() + '）：' + res.getContentText());
    }
  });
}

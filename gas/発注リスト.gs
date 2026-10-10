/**
 * 発注リスト（資材の発注点管理）
 * ------------------------------------------------------------
 * ・農薬在庫／肥料在庫の各資材に「発注点・発注量・発注先」を設定する
 * ・在庫量が発注点以下になったら「要発注」として、発注リスト画面と朝の段取りLINEに出す
 * ・既存の在庫シート・addStock/updateStock には手を入れず、別シート「発注設定」に保存する
 *
 * 【doGet への追加（1行だけ）】
 *   doGet(e) の先頭（最初の行）に次の1行を入れてください。
 *     var rx = extraRoute_(e.parameter); if (rx) return reply(rx, e.parameter.callback);
 *
 * 追加される action（すべて GET）
 *   listReorder   … 発注設定の一覧
 *   saveReorder   … 発注設定の保存（資材ID・種別 必須）
 *   deleteReorder … 発注設定の削除（資材ID）
 *   morningPreview… 朝の段取りの文面を返す（送信しない）
 *   sendMorning   … 朝の段取りを今すぐLINEに送る
 */

var REORDER_SHEET = '発注設定';
var REORDER_HEADERS = ['種別', '資材ID', '名前', '発注点', '発注量', '単位', '発注先', '連絡先', '発注済日', '更新日時'];
// GASがスプレッドシートに紐づいていない場合の保存先（作業書と同じ「農薬管理」）
var REORDER_FALLBACK_SS = '1I-s9T_rvJCcgytP8HkYqN7SaJg4QQ8G0geoTT2jif8A';

/* ---------- ルーター（doGet の先頭から呼ぶ） ---------- */
function extraRoute_(p) {
  if (!p || !p.action) return null;
  switch (p.action) {
    case 'listReorder':    return listReorder_();
    case 'saveReorder':    return saveReorder_(p);
    case 'deleteReorder':  return deleteReorder_(p);
    case 'morningPreview': return { ok: true, text: buildMorningText_() };
    case 'sendMorning':    return sendMorningNow_();
  }
  return null;
}

/* ---------- シート ---------- */
function reorderSS_() {
  var id = PropertiesService.getScriptProperties().getProperty('REORDER_SS_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  return ss || SpreadsheetApp.openById(REORDER_FALLBACK_SS);
}

function reorderSheet_() {
  var ss = reorderSS_();
  var sh = ss.getSheetByName(REORDER_SHEET);
  if (!sh) {
    sh = ss.insertSheet(REORDER_SHEET);
    sh.getRange(1, 1, 1, REORDER_HEADERS.length).setValues([REORDER_HEADERS]);
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('@');   // 資材ID は文字列のまま
    sh.getRange('I:J').setNumberFormat('@');   // 日付は文字列で保存（UTCずれ防止）
  }
  return sh;
}

function reorderRows_() {
  var sh = reorderSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(1, 1, last, REORDER_HEADERS.length).getDisplayValues();
  var head = vals[0];
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    if (!vals[i][1]) continue;
    var o = { _row: i + 1 };
    for (var c = 0; c < head.length; c++) o[head[c]] = vals[i][c];
    out.push(o);
  }
  return out;
}

/* ---------- API ---------- */
function listReorder_() {
  var items = reorderRows_().map(function (r) { var o = {}; for (var k in r) if (k !== '_row') o[k] = r[k]; return o; });
  return { ok: true, items: items };
}

function saveReorder_(p) {
  var id = String(p['資材ID'] || p.id || '').trim();
  var kind = String(p['種別'] || '').trim();
  if (!id) return { ok: false, error: '資材IDがありません' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = reorderSheet_();
    var rows = reorderRows_();
    var hit = null;
    for (var i = 0; i < rows.length; i++) if (String(rows[i]['資材ID']) === id) { hit = rows[i]; break; }
    var rec = hit || {};
    rec['種別'] = kind || rec['種別'] || '';
    rec['資材ID'] = id;
    ['名前', '発注点', '発注量', '単位', '発注先', '連絡先'].forEach(function (k) {
      if (p[k] !== undefined) rec[k] = String(p[k]).trim();
    });
    if (p.ordered === '1') rec['発注済日'] = jstDate_(new Date());
    else if (p.ordered === '0') rec['発注済日'] = '';
    rec['更新日時'] = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    var line = REORDER_HEADERS.map(function (h) { return rec[h] == null ? '' : String(rec[h]); });
    if (hit) sh.getRange(hit._row, 1, 1, line.length).setValues([line]);
    else sh.appendRow(line);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function deleteReorder_(p) {
  var id = String(p['資材ID'] || p.id || '').trim();
  if (!id) return { ok: false, error: '資材IDがありません' };
  var rows = reorderRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i]['資材ID']) === id) { reorderSheet_().deleteRow(rows[i]._row); return { ok: true }; }
  }
  return { ok: false, error: '見つかりません' };
}

/* ---------- 判定（朝の段取りからも使う） ---------- */
function num_(v) {
  var n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

/**
 * 在庫一覧（農薬・肥料）と発注設定から、要発注／入荷待ちを判定する。
 * 在庫が発注点より多く戻っていたら「発注済日」を自動で消す。
 */
function reorderStatus_(stockList, fertList) {
  var settings = reorderRows_();
  var map = {};
  settings.forEach(function (s) { map[String(s['資材ID'])] = s; });

  var all = [];
  (stockList || []).forEach(function (t) {
    all.push({ kind: '農薬', id: String(t['在庫ID'] || ''), name: t['農薬名'] || '', qty: t['在庫量'], unit: t['単位'] || '' });
  });
  (fertList || []).forEach(function (t) {
    all.push({ kind: '肥料', id: String(t['肥料ID'] || ''), name: t['肥料名'] || '', qty: t['在庫量'], unit: t['単位'] || '' });
  });

  var need = [], waiting = [], clear = [];
  all.forEach(function (m) {
    var s = map[m.id];
    if (!s) return;
    var point = num_(s['発注点']);
    var qty = num_(m.qty);
    if (point == null || qty == null) return;
    var item = {
      kind: m.kind, id: m.id, name: m.name, qty: qty, unit: m.unit || s['単位'] || '',
      point: point, amount: s['発注量'] || '', supplier: s['発注先'] || '', contact: s['連絡先'] || '',
      ordered: s['発注済日'] || ''
    };
    if (qty <= point) {
      if (item.ordered) waiting.push(item); else need.push(item);
    } else if (item.ordered) {
      clear.push(s);
    }
  });

  // 入荷して在庫が戻ったものは発注済日をクリア
  if (clear.length) {
    var sh = reorderSheet_();
    var col = REORDER_HEADERS.indexOf('発注済日') + 1;
    clear.forEach(function (s) { sh.getRange(s._row, col).setValue(''); });
  }
  return { need: need, waiting: waiting };
}

function jstDate_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

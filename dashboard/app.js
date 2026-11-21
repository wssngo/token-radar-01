// Token Launch Radar — the page's logic. Everything renders from window.RADAR, the dataset
// main.ts wrote beside this page: no fetch, no network, the file works from disk as it stands.
// State lives in the URL hash (filters, sort, the open protocol), so any view can be linked,
// screenshotted and reproduced exactly.

(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) return;

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    meta: $('snapshot-meta'), method: $('method-text'), stats: $('stats'), foot: $('foot-note'),
    search: $('f-search'), category: $('f-category'), chain: $('f-chain'), min: $('f-min'),
    watch: $('f-watch'), sort: $('f-sort'),
    tabBoard: $('tab-board'), tabLive: $('tab-live'),
    boardTable: $('board-table'), boardBody: $('board-body'),
    liveTable: $('live-table'), liveBody: $('live-body'),
    empty: $('empty'), detail: $('detail'), scrim: $('scrim'),
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function group(n) {
    var s = String(Math.round(Math.abs(n)));
    var out = '';
    while (s.length > 3) { out = ',' + s.slice(-3) + out; s = s.slice(0, -3); }
    return (n < 0 ? '-' : '') + s + out;
  }
  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + trimNum(n / 1e9) + 'B';
    if (n >= 1e6) return '$' + trimNum(n / 1e6) + 'M';
    if (n >= 1e3) return '$' + trimNum(n / 1e3) + 'K';
    return '$' + group(n);
  }
  function trimNum(x) {
    return (Math.round(x * 100) / 100).toString().replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
  }
  function pct(x) {
    if (x == null) return '<span class="chains">n/a</span>';
    var cls = x >= 0 ? 'pos' : 'neg';
    var sign = x >= 0 ? '+' : '−';
    return '<span class="' + cls + '">' + sign + trimNum(Math.abs(x)) + '%</span>';
  }
  function ageText(days) {
    if (days == null) return 'unknown';
    if (days < 90) return days + 'd';
    if (days < 730) return Math.round(days / 30.4) + ' mo';
    return trimNum(days / 365.25) + ' yrs';
  }

  // ---- header and method -------------------------------------------------
  els.meta.innerHTML =
    '<div>Snapshot <b>' + esc(R.as_of) + '</b> · DefiLlama protocol universe</div>' +
    '<div><b>' + group(R.universe_size) + '</b> protocols · <b>' + R.watchlist_size + '</b> on the watchlist · <b>' +
    R.board_size + '</b> ranked</div>' +
    '<span class="chip">MODEL ' + esc(R.model_version) + '</span>';
  els.method.innerHTML =
    'Implied value = <code>TVL x category multiple x growth x maturity x reach</code>. The <b>category multiple</b> is not a guess: ' +
    'it is the median market-cap/TVL among the <b>' + R.model.trading_protocols + ' protocols in the snapshot with a recorded market cap</b> ' +
    '(global median <b>' + R.model.global_median_ratio.toFixed(2) + 'x</b>), shrunk toward that median when a category has few peers. ' +
    '<b>Growth</b> reads the protocol\u2019s own 7-day TVL change, <b>maturity</b> how long it has run with no token, <b>reach</b> how many chains it serves. ' +
    'No name is special-cased: one function prices every row, and each row\u2019s detail view shows its arithmetic.';
  els.foot.textContent =
    'Data: ' + R.source + '. The board ranks protocols that record no token in that snapshot; "records no token" is what the data supports — ' +
    'a protocol may still have a token its record does not carry. Implied value is this board\u2019s own model claim about a hypothetical launch, ' +
    'not a prediction that a token will be issued. Farm plans are checklists, not financial advice: costs are typical-fee estimates and positions can lose money.';

  // ---- state ---------------------------------------------------------------
  function readState() {
    var h = new URLSearchParams(location.hash.replace(/^#/, ''));
    return {
      view: h.get('view') === 'live' ? 'live' : 'board',
      q: h.get('q') || '',
      cat: h.get('cat') || '',
      chain: h.get('chain') || '',
      min: Number(h.get('min') || 0),
      wl: h.get('wl') === '1',
      sort: h.get('sort') || 'implied',
      p: h.get('p') || '',
    };
  }
  function writeState(st) {
    var h = new URLSearchParams();
    if (st.view === 'live') h.set('view', 'live');
    if (st.q) h.set('q', st.q);
    if (st.cat) h.set('cat', st.cat);
    if (st.chain) h.set('chain', st.chain);
    if (st.min) h.set('min', String(st.min));
    if (st.wl) h.set('wl', '1');
    if (st.sort !== 'implied') h.set('sort', st.sort);
    if (st.p) h.set('p', st.p);
    history.replaceState(null, '', '#' + h.toString());
  }

  // ---- filter options --------------------------------------------------------
  var cats = [];
  var catSeen = {};
  var chains = [];
  var chainSeen = {};
  R.rows.forEach(function (r) {
    var c = r.category || 'Uncategorized';
    if (!catSeen[c]) { catSeen[c] = 1; cats.push(c); }
    r.chains.forEach(function (ch) { if (!chainSeen[ch]) { chainSeen[ch] = 1; chains.push(ch); } });
  });
  cats.sort(); chains.sort();
  els.category.innerHTML = '<option value="">All categories</option>' + cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
  els.chain.innerHTML = '<option value="">All chains</option>' + chains.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  var catStats = {};
  R.categories.forEach(function (c) { catStats[c.category] = c; });
  var bySlug = {};
  R.rows.forEach(function (r) { bySlug[r.slug] = r; });

  // ---- rendering ---------------------------------------------------------------
  function filteredRows(st) {
    var rows = R.rows.filter(function (r) {
      if (st.wl && !r.watchlist) return false;
      if (st.cat && (r.category || 'Uncategorized') !== st.cat) return false;
      if (st.chain && r.chains.indexOf(st.chain) < 0) return false;
      if (st.min && r.tvl_usd < st.min) return false;
      if (st.q) {
        var q = st.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      }
      return true;
    });
    var by = {
      implied: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d == null ? -1e9 : b.change_7d) - (a.change_7d == null ? -1e9 : a.change_7d); },
      age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); },
      name: function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; },
    };
    return rows.sort(by[st.sort] || by.implied);
  }

  function renderBoard(st) {
    var rows = filteredRows(st);
    var totalImplied = rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    els.stats.innerHTML =
      'Showing <b>' + rows.length + '</b> of <b>' + R.board_size + '</b> ranked protocols · combined implied value <b>' +
      money(totalImplied) + '</b> · click a row for its pricing and farm plan';
    els.boardBody.innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.rank <= 3 ? ' class="top"' : '') + '>' +
        '<td class="num rank">' + r.rank + '</td>' +
        '<td class="pname">' + esc(r.name) + (r.watchlist ? '<span class="wl">WATCHLIST</span>' : '') + '</td>' +
        '<td class="cat">' + esc(r.category || 'Uncategorized') + '</td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '<td class="num">' + r.model.category_multiple.toFixed(2) + 'x</td>' +
        '<td class="num implied">' + money(r.implied_value_usd) + '</td></tr>';
    }).join('');
    els.empty.classList.toggle('hidden', rows.length > 0);
    Array.prototype.forEach.call(els.boardBody.querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () {
        var st2 = readState(); st2.p = tr.getAttribute('data-slug'); writeState(st2); render();
      });
    });
  }

  function renderLive() {
    els.liveBody.innerHTML = R.live.map(function (r) {
      return '<tr><td class="pname">' + esc(r.name) + '</td><td class="cat">' + esc(r.symbol || '—') + '</td>' +
        '<td class="cat">' + esc(r.category || 'Uncategorized') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + money(r.mcap_usd) + '</td>' +
        '<td class="num">' + (r.mcap_tvl == null ? '—' : r.mcap_tvl.toFixed(2) + 'x') + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td></tr>';
    }).join('');
    els.stats.innerHTML =
      'The <b>' + R.live_size + '</b> largest protocols whose token already trades — the market\u2019s own prices. ' +
      'They never enter the ranked board; they calibrate its category multiples.';
  }

  function factorRow(label, value, widthPct, base) {
    return '<div class="factor' + (base ? ' base' : '') + '"><div class="frow"><span>' + label + '</span><b>' +
      value + '</b></div><div class="bar"><i style="width:' + Math.max(2, Math.min(100, widthPct)) + '%"></i></div></div>';
  }

  function renderDetail(st) {
    var r = st.p ? bySlug[st.p] : null;
    if (!r) { els.detail.classList.add('hidden'); els.scrim.classList.add('hidden'); return; }
    var m = r.model;
    var stat = catStats[r.category || 'Uncategorized'];
    var base = r.tvl_usd * m.category_multiple;
    var peerNote = stat
      ? 'In this snapshot, ' + stat.trading_peers + ' ' + esc(stat.category) +
        (stat.trading_peers === 1 ? ' protocol carries a recorded market cap' : ' protocols carry a recorded market cap') +
        (stat.peer_median_ratio == null ? '' : '; the median market cap among them is ' + stat.peer_median_ratio.toFixed(2) + 'x TVL') +
        '. After shrinkage toward the global median (' + R.model.global_median_ratio.toFixed(2) + 'x), the model prices ' +
        esc(r.name) + ' at ' + m.category_multiple.toFixed(2) + 'x its TVL.'
      : '';
    els.detail.innerHTML =
      '<button class="close" id="d-close" type="button" aria-label="Close">×</button>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">Rank #' + r.rank + ' of ' + R.board_size + ' · ' + esc(r.category || 'Uncategorized') + ' · ' +
      esc(r.chains.join(', ') || 'no chains recorded') + (r.watchlist ? ' · <span class="wl">ON THE WATCHLIST</span>' : ' · early, below the watchlist floor') + '</p>' +
      '<div class="kvgrid">' +
      '<div class="kv"><span>Implied value</span><b class="amber">' + money(r.implied_value_usd) + '</b></div>' +
      '<div class="kv"><span>TVL (snapshot)</span><b>' + money(r.tvl_usd) + '</b></div>' +
      '<div class="kv"><span>7-day TVL change</span><b>' + (r.change_7d == null ? 'n/a' : (r.change_7d >= 0 ? '+' : '−') + trimNum(Math.abs(r.change_7d)) + '%') + '</b></div>' +
      '<div class="kv"><span>Tracked, no token, for</span><b>' + ageText(r.age_days) + '</b></div>' +
      '</div>' +
      '<h3>How this value is priced</h3>' +
      '<p class="note">' + peerNote + '</p>' +
      factorRow('Base: TVL x ' + m.category_multiple.toFixed(2) + ' category multiple', money(base), 100 * Math.min(1, base / (base + r.tvl_usd)), true) +
      factorRow('Growth x' + m.growth_factor.toFixed(2) + ' (7d change ' + (m.growth_pct >= 0 ? '+' : '−') + trimNum(Math.abs(m.growth_pct)) + '%, clamped)', 'x' + m.growth_factor.toFixed(2), m.growth_factor * 55, false) +
      factorRow('Maturity x' + m.maturity_factor.toFixed(2) + ' (' + ageText(r.age_days) + ' with no token)', 'x' + m.maturity_factor.toFixed(2), m.maturity_factor * 70, false) +
      factorRow('Reach x' + m.reach_factor.toFixed(2) + ' (' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ')', 'x' + m.reach_factor.toFixed(2), m.reach_factor * 70, false) +
      '<p class="note">Base x growth x maturity x reach = <b>' + money(r.implied_value_usd) + '</b> implied value if a token were issued against this record.</p>' +
      '<h3>How to farm it</h3>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    els.detail.classList.remove('hidden');
    els.scrim.classList.remove('hidden');
    $('d-close').addEventListener('click', closeDetail);
  }
  function closeDetail() {
    var st = readState(); st.p = ''; writeState(st); render();
  }
  els.scrim.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

  function render() {
    var st = readState();
    els.tabBoard.classList.toggle('active', st.view === 'board');
    els.tabLive.classList.toggle('active', st.view === 'live');
    els.boardTable.classList.toggle('hidden', st.view !== 'board');
    els.liveTable.classList.toggle('hidden', st.view !== 'live');
    if (document.activeElement !== els.search) els.search.value = st.q;
    els.category.value = st.cat;
    els.chain.value = st.chain;
    els.min.value = String(st.min);
    els.watch.checked = st.wl;
    els.sort.value = st.sort;
    if (st.view === 'live') { els.empty.classList.add('hidden'); renderLive(); }
    else renderBoard(st);
    renderDetail(st);
  }

  function bind(el, ev, fn) { el.addEventListener(ev, function () { var st = readState(); fn(st); writeState(st); render(); }); }
  bind(els.search, 'input', function (st) { st.q = els.search.value; });
  bind(els.category, 'change', function (st) { st.cat = els.category.value; });
  bind(els.chain, 'change', function (st) { st.chain = els.chain.value; });
  bind(els.min, 'change', function (st) { st.min = Number(els.min.value); });
  bind(els.watch, 'change', function (st) { st.wl = els.watch.checked; });
  bind(els.sort, 'change', function (st) { st.sort = els.sort.value; });
  els.tabBoard.addEventListener('click', function () { var st = readState(); st.view = 'board'; writeState(st); render(); });
  els.tabLive.addEventListener('click', function () { var st = readState(); st.view = 'live'; writeState(st); render(); });
  window.addEventListener('hashchange', render);
  render();
})();

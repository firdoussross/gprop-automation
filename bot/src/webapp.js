// The GProp visitor-pass mini-app (Telegram Web App) served at /app.
// A private form the family member fills in; on submit it POSTs the form plus
// Telegram initData to /app/submit, which verifies the signature + group
// membership, creates the visitor, and posts the pass to the family group.

export const WEBAPP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Visitor Pass</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { --orange:#F3B343; --orange-d:#e09a2a; --ink:#1d1b20; }
  * { box-sizing: border-box; }
  body {
    margin:0; font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #1d1b20);
    padding: 16px; -webkit-font-smoothing: antialiased;
  }
  h1 { font-size: 20px; margin: 4px 0 2px; }
  .sub { color: var(--tg-theme-hint-color, #8a8a8e); font-size: 13px; margin-bottom: 18px; }
  label { display:block; font-size: 13px; font-weight: 600; margin: 16px 0 7px; }
  .types { display:grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .type {
    border: 1.5px solid var(--tg-theme-hint-color, #d8d8dc); border-radius: 12px;
    padding: 12px 10px; text-align:center; font-size: 14px; font-weight: 600; cursor:pointer;
    background: var(--tg-theme-secondary-bg-color, #f3f4f6); user-select:none;
  }
  .type.sel { border-color: var(--orange); background: rgba(243,179,67,.16); color: var(--ink); }
  .type.full { grid-column: 1 / -1; }
  input {
    width:100%; padding: 13px 14px; font-size: 16px; border-radius: 12px;
    border: 1.5px solid var(--tg-theme-hint-color, #d8d8dc);
    background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #1d1b20);
  }
  input:focus { outline:none; border-color: var(--orange); }
  .row { display:none; }
  .row.show { display:block; }
  .hint { font-size:12px; color: var(--tg-theme-hint-color,#8a8a8e); margin-top:6px; }
  #err { color:#d23b3b; font-size:13px; margin-top:14px; min-height:18px; }
  #go {
    width:100%; margin-top:22px; padding:15px; font-size:16px; font-weight:700;
    border:none; border-radius:13px; background: var(--orange); color:#231a06; cursor:pointer;
  }
  #go:disabled { opacity:.55; }
  #done { text-align:center; padding:40px 10px; display:none; }
  #done .big { font-size:46px; }
  #done h2 { margin:14px 0 6px; }
</style>
</head>
<body>
<div id="form">
  <h1>New visitor pass</h1>
  <div class="sub">Unit RB-034B · the pass posts to your family group.</div>

  <label>Type of pass</label>
  <div class="types" id="types">
    <div class="type full" data-k="social">👤 Social visitor</div>
    <div class="type" data-k="grab">🛵 Grab</div>
    <div class="type" data-k="lalamove">🛵 Lalamove</div>
    <div class="type" data-k="foodpanda">🍔 Foodpanda</div>
    <div class="type" data-k="other">📦 Other delivery</div>
  </div>

  <div class="row" id="row-name">
    <label id="lab-name">Visitor name</label>
    <input id="name" autocomplete="off" placeholder="e.g. Ahmad">
  </div>

  <div class="row" id="row-vehicle">
    <label>Vehicle reg <span style="font-weight:400;opacity:.6">(optional)</span></label>
    <input id="vehicle" autocomplete="off" placeholder="e.g. VNT1234" autocapitalize="characters">
  </div>

  <div class="row" id="row-date">
    <label>Visit date</label>
    <input id="date" type="date">
    <div class="hint">Passes are valid for the day (GProp rule).</div>
  </div>

  <div id="err"></div>
  <button id="go" disabled>Create pass</button>
</div>

<div id="done">
  <div class="big">✅</div>
  <h2>Pass created</h2>
  <div class="sub" id="done-msg">Posted to your group.</div>
</div>

<script>
  var tg = window.Telegram ? window.Telegram.WebApp : null;
  if (tg) { tg.ready(); tg.expand(); }
  var sel = null;
  var PRESET = { grab:1, lalamove:1, foodpanda:1 };

  function show(id, on){ document.getElementById(id).classList.toggle('show', on); }
  function refresh(){
    var isSocial = sel === 'social';
    var isOther = sel === 'other';
    show('row-name', isSocial || isOther);
    document.getElementById('lab-name').textContent = isOther ? 'Delivery company' : 'Visitor name';
    document.getElementById('name').placeholder = isOther ? 'e.g. Shopee Express' : 'e.g. Ahmad';
    show('row-vehicle', !!sel);
    show('row-date', !!sel);
    document.getElementById('go').disabled = !sel;
  }
  var types = document.querySelectorAll('.type');
  types.forEach(function(el){
    el.addEventListener('click', function(){
      types.forEach(function(t){ t.classList.remove('sel'); });
      el.classList.add('sel'); sel = el.getAttribute('data-k');
      document.getElementById('err').textContent='';
      refresh();
    });
  });
  // default date = today (device local)
  (function(){ var d=new Date(); var p=function(n){return (n<10?'0':'')+n;};
    document.getElementById('date').value = d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); })();

  function err(m){ document.getElementById('err').textContent = m || ''; }

  document.getElementById('go').addEventListener('click', function(){
    err('');
    var name = document.getElementById('name').value.trim();
    var vehicle = document.getElementById('vehicle').value.trim();
    var date = document.getElementById('date').value;
    if (!sel) return err('Pick a type of pass.');
    if (sel === 'social' && !name) return err('Enter the visitor name.');
    if (sel === 'other' && !name) return err('Enter the delivery company.');
    if (!date) return err('Pick a visit date.');

    var btn = document.getElementById('go'); btn.disabled = true; btn.textContent = 'Creating…';
    fetch('/app/submit', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ initData: tg ? tg.initData : '', dest: new URLSearchParams(location.search).get('dest') || '', kind: sel, name: name, vehicle: vehicle, date: date })
    }).then(function(r){ return r.json(); }).then(function(res){
      if (res && res.ok) {
        document.getElementById('form').style.display='none';
        document.getElementById('done').style.display='block';
        document.getElementById('done-msg').textContent = res.qr ? ('Pass no ' + res.qr + ' — posted to your group.') : 'Posted to your group.';
        if (tg) setTimeout(function(){ tg.close(); }, 1600);
      } else {
        btn.disabled=false; btn.textContent='Create pass';
        err((res && res.error) || 'Something went wrong. Try again.');
      }
    }).catch(function(){ btn.disabled=false; btn.textContent='Create pass'; err('Network error. Try again.'); });
  });
</script>
</body>
</html>`;

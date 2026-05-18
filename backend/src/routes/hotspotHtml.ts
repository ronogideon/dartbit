import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma';

const router = Router();

// GET /hotspot-html/login?apiKey=xxx
// Returns the FULL captive portal HTML stored locally on MikroTik as hotspot/login.html.
// Three flows: Buy package, Redeem voucher, Account login.
// All verification done via AJAX to Dartbit backend; success → form-POST to MikroTik link-login.
router.get('/login', async (req: Request, res: Response) => {
  try {
    const apiKey = String(req.query.apiKey || '');
    if (!apiKey) return res.status(400).type('text/plain').send('<!-- missing apiKey -->');

    const r = await prisma.mikrotikRouter.findUnique({
      where: { apiKey },
      include: { tenant: true },
    });
    if (!r) return res.status(404).type('text/plain').send('<!-- router not found -->');

    let backendUrl = process.env.BACKEND_URL || 'https://dartbit-production.up.railway.app';
    if (backendUrl.startsWith('http://') && backendUrl.includes('railway.app')) {
      backendUrl = backendUrl.replace('http://', 'https://');
    }

    const tenantName = r.tenant.name.replace(/[<>"&]/g, '');

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>${tenantName} WiFi</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#030712;color:#fff;min-height:100vh;-webkit-font-smoothing:antialiased}
body{display:flex;align-items:center;justify-content:center;padding:16px;min-height:100vh}
.wrap{width:100%;max-width:400px}
.brand{text-align:center;margin-bottom:24px}
.logo-box{width:56px;height:56px;background:#2563eb;border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;box-shadow:0 10px 30px rgba(37,99,235,.4)}
.logo-box svg{width:28px;height:28px;color:#fff}
.brand h1{font-size:24px;font-weight:700;color:#fff;letter-spacing:-.5px}
.brand p{color:#9ca3af;margin-top:4px;font-size:13px}
.card{background:#111827;border:1px solid #1f2937;border-radius:16px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.5)}
.tabs{display:flex;gap:2px;margin-bottom:18px;background:#030712;padding:3px;border-radius:10px;border:1px solid #1f2937}
.tab{flex:1;padding:9px 6px;text-align:center;font-size:12px;font-weight:600;color:#6b7280;cursor:pointer;border-radius:8px;transition:all .15s;user-select:none}
.tab:hover{color:#9ca3af}
.tab.active{background:#2563eb;color:#fff;box-shadow:0 4px 10px rgba(37,99,235,.3)}
.panel{display:none}
.panel.active{display:block}
h2{font-size:15px;font-weight:600;color:#fff;margin-bottom:4px}
p.help{font-size:13px;color:#9ca3af;margin-bottom:16px;line-height:1.5}
label{display:block;font-size:12px;font-weight:500;color:#d1d5db;margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid #374151;border-radius:8px;font-size:14px;outline:none;background:#1f2937;color:#fff;transition:border .15s,box-shadow .15s;margin-bottom:12px}
input.code{letter-spacing:3px;text-transform:uppercase;text-align:center;font-weight:700;font-size:18px}
input::placeholder{color:#6b7280}
input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.2)}
button.primary{width:100%;padding:11px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;display:flex;align-items:center;justify-content:center;gap:6px}
button.primary:hover{background:#1d4ed8}
button.primary:disabled{opacity:.5;cursor:not-allowed}
button.primary svg{width:14px;height:14px}
.pkg-list{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.pkg-card{background:#0b1220;border:1px solid #1f2937;border-radius:10px;padding:12px;cursor:pointer;transition:all .15s;display:flex;align-items:center;justify-content:space-between}
.pkg-card:hover{border-color:#374151;background:#111827}
.pkg-card.selected{border-color:#2563eb;background:rgba(37,99,235,.08);box-shadow:0 0 0 1px #2563eb}
.pkg-name{font-size:14px;font-weight:600;color:#fff;margin-bottom:2px}
.pkg-meta{font-size:11px;color:#9ca3af}
.pkg-price{font-size:16px;font-weight:700;color:#22c55e;text-align:right}
.pkg-price small{font-size:10px;color:#6b7280;font-weight:500;display:block;margin-top:2px}
.status{margin-top:14px;padding:10px 12px;border-radius:8px;font-size:13px;line-height:1.4;display:none}
.status.error{background:rgba(239,68,68,.1);color:#fca5a5;border:1px solid rgba(239,68,68,.2);display:block}
.status.success{background:rgba(34,197,94,.1);color:#86efac;border:1px solid rgba(34,197,94,.2);display:block}
.status.info{background:rgba(37,99,235,.1);color:#93c5fd;border:1px solid rgba(37,99,235,.2);display:block}
.code-display{background:#030712;border:2px dashed #374151;border-radius:10px;padding:14px;text-align:center;margin:12px 0}
.code-display .label{font-size:11px;color:#9ca3af;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px}
.code-display .code{font-size:28px;font-weight:700;color:#22c55e;letter-spacing:4px;font-family:ui-monospace,"SF Mono",Menlo,monospace}
.spinner{width:14px;height:14px;border:2px solid #fff;border-right-color:transparent;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.footer{font-size:11px;color:#4b5563;text-align:center;margin-top:18px}
.empty{text-align:center;padding:24px 12px;color:#6b7280;font-size:13px}
</style>
</head>
<body>
<div class="wrap">

  <div class="brand">
    <div class="logo-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
    </div>
    <h1>${tenantName}</h1>
    <p>WiFi Sign-in</p>
  </div>

  <div class="card">
    <div class="tabs">
      <div class="tab active" data-tab="buy">Buy</div>
      <div class="tab" data-tab="voucher">Voucher</div>
      <div class="tab" data-tab="account">Account</div>
    </div>

    <div class="panel active" id="panel-buy">
      <h2>Buy a WiFi package</h2>
      <p class="help">Pick a package below to get a code instantly.</p>
      <div class="pkg-list" id="pkg-list"><div class="empty">Loading packages...</div></div>
      <div style="margin-bottom:12px">
        <label>Phone (optional)</label>
        <input id="buy-phone" placeholder="e.g. 0712345678" inputmode="tel" autocomplete="tel">
      </div>
      <button class="primary" id="buy-btn" disabled>Get my voucher</button>
    </div>

    <div class="panel" id="panel-voucher">
      <h2>Got a voucher?</h2>
      <p class="help">Enter the code from your ticket below.</p>
      <form id="voucher-form">
        <label>Voucher code</label>
        <input class="code" id="voucher-code" placeholder="XXXXXXXX" maxlength="16" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" required>
        <button type="submit" class="primary" id="voucher-btn">Connect</button>
      </form>
    </div>

    <div class="panel" id="panel-account">
      <h2>Sign in with your account</h2>
      <p class="help">For ${tenantName} subscribers with an active plan.</p>
      <form id="account-form">
        <label>Username</label>
        <input id="account-username" placeholder="Your username" autocomplete="username" autocapitalize="none" required>
        <label>Password</label>
        <input id="account-password" type="password" placeholder="Your password" autocomplete="current-password" required>
        <button type="submit" class="primary" id="account-btn">Sign in</button>
      </form>
    </div>

    <div id="status" class="status"></div>
  </div>

  <div class="footer">Powered by Dartbit</div>
</div>

<form id="mikrotik-login" name="login" action="$(link-login-only)" method="post" style="display:none">
  <input id="mt-username" type="hidden" name="username">
  <input id="mt-password" type="hidden" name="password">
  <input type="hidden" name="dst" value="$(link-orig)">
  <input type="hidden" name="popup" value="true">
</form>

<script>
(function(){
  var BACKEND='${backendUrl}';
  var API_KEY='${apiKey}';
  var MAC='$(mac)';
  var IP='$(ip)';
  var selectedPkg=null;
  var st=document.getElementById('status');

  function show(t,msg){st.className='status '+t;st.innerHTML=msg}
  function clr(){st.className='status';st.innerHTML=''}
  function spinner(){return '<span class="spinner"></span>'}

  // Tab switching
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i++){
    tabs[i].addEventListener('click',function(){
      var n=this.getAttribute('data-tab');
      var ats=document.querySelectorAll('.tab');
      var aps=document.querySelectorAll('.panel');
      for(var j=0;j<ats.length;j++)ats[j].classList.remove('active');
      for(var k=0;k<aps.length;k++)aps[k].classList.remove('active');
      this.classList.add('active');
      document.getElementById('panel-'+n).classList.add('active');
      clr();
    });
  }

  function submitMikrotik(u,p){
    document.getElementById('mt-username').value=u;
    document.getElementById('mt-password').value=p;
    document.getElementById('mikrotik-login').submit();
  }

  function fmtDur(m){
    if(m<60)return m+' min';
    if(m<1440)return Math.round(m/60*10)/10+' hr';
    return Math.round(m/1440*10)/10+' day';
  }
  function fmtSpeed(k){
    if(k>=1024)return (k/1024).toFixed(0)+'M';
    return k+'K';
  }

  // === BUY: load packages from backend ===
  function loadPackages(){
    var xhr=new XMLHttpRequest();
    xhr.open('GET',BACKEND+'/hotspot/packages?apiKey='+API_KEY,true);
    xhr.timeout=10000;
    xhr.onload=function(){
      try{
        var data=JSON.parse(xhr.responseText);
        renderPackages(data.success?data.packages:[]);
      }catch(e){renderPackages([])}
    };
    xhr.onerror=function(){renderPackages([])};
    xhr.ontimeout=function(){renderPackages([])};
    xhr.send();
  }
  function renderPackages(pkgs){
    var list=document.getElementById('pkg-list');
    if(!pkgs||pkgs.length===0){
      list.innerHTML='<div class="empty">No packages available right now.<br><span style="font-size:11px">Try the Voucher tab if you have a code.</span></div>';
      return;
    }
    list.innerHTML='';
    pkgs.forEach(function(p){
      var d=document.createElement('div');
      d.className='pkg-card';
      d.setAttribute('data-id',p.id);
      d.innerHTML='<div><div class="pkg-name">'+escapeHtml(p.name)+'</div><div class="pkg-meta">'+fmtSpeed(p.speedDownKbps)+'bps · '+fmtDur(p.validityMinutes)+'</div></div>'+
                  '<div class="pkg-price">KES '+p.price.toFixed(0)+'<small>'+fmtDur(p.validityMinutes)+'</small></div>';
      d.addEventListener('click',function(){
        document.querySelectorAll('.pkg-card').forEach(function(x){x.classList.remove('selected')});
        this.classList.add('selected');
        selectedPkg=p;
        document.getElementById('buy-btn').disabled=false;
      });
      list.appendChild(d);
    });
  }
  function escapeHtml(s){var d=document.createElement('div');d.innerText=s;return d.innerHTML}

  // === BUY: purchase package ===
  document.getElementById('buy-btn').addEventListener('click',function(){
    if(!selectedPkg)return;
    var btn=this;
    var phone=document.getElementById('buy-phone').value.trim();
    btn.disabled=true;btn.innerHTML=spinner()+' Creating...';
    clr();
    var xhr=new XMLHttpRequest();
    xhr.open('POST',BACKEND+'/hotspot/purchase',true);
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.timeout=20000;
    xhr.onload=function(){
      try{
        var data=JSON.parse(xhr.responseText);
        if(!data.success){
          show('error',data.error||'Purchase failed');
          btn.disabled=false;btn.textContent='Get my voucher';
          return;
        }
        // Wait for router to sync the voucher (cmd polls every 5s)
        var secsLeft=12;
        var codeBox='<div class="code-display"><div class="label">Your voucher code</div><div class="code">'+data.code+'</div></div>';
        show('success',codeBox+'Activating session ('+secsLeft+'s)...');
        var iv=setInterval(function(){
          secsLeft--;
          if(secsLeft<=0){
            clearInterval(iv);
            show('success',codeBox+'Connecting now...');
            submitMikrotik(data.code,data.code);
          } else {
            show('success',codeBox+'Activating session ('+secsLeft+'s)...');
          }
        },1000);
      }catch(e){
        show('error','Server response error');
        btn.disabled=false;btn.textContent='Get my voucher';
      }
    };
    xhr.onerror=function(){show('error','Cannot reach server. Check connection.');btn.disabled=false;btn.textContent='Get my voucher'};
    xhr.ontimeout=function(){show('error','Server timeout.');btn.disabled=false;btn.textContent='Get my voucher'};
    xhr.send(JSON.stringify({packageId:selectedPkg.id,routerApiKey:API_KEY,phone:phone,mac:MAC,ip:IP}));
  });

  // === VOUCHER flow ===
  document.getElementById('voucher-form').addEventListener('submit',function(e){
    e.preventDefault();
    var btn=document.getElementById('voucher-btn');
    var code=document.getElementById('voucher-code').value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(!code){show('error','Please enter a voucher code');return}
    btn.disabled=true;btn.innerHTML=spinner()+' Checking...';
    clr();
    var xhr=new XMLHttpRequest();
    xhr.open('POST',BACKEND+'/hotspot/redeem',true);
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.timeout=15000;
    xhr.onload=function(){
      try{
        var data=JSON.parse(xhr.responseText);
        if(!data.success){show('error',data.error||'Invalid voucher');btn.disabled=false;btn.textContent='Connect';return}
        // Voucher is already on the router (pushed at generation). Submit immediately.
        show('success','Voucher accepted! Connecting...');
        setTimeout(function(){submitMikrotik(data.username,data.password)},500);
      }catch(e){show('error','Server response error');btn.disabled=false;btn.textContent='Connect'}
    };
    xhr.onerror=function(){show('error','Cannot reach server. Check connection.');btn.disabled=false;btn.textContent='Connect'};
    xhr.ontimeout=function(){show('error','Server timeout.');btn.disabled=false;btn.textContent='Connect'};
    xhr.send(JSON.stringify({code:code,routerApiKey:API_KEY,mac:MAC,ip:IP}));
  });

  // === ACCOUNT flow ===
  document.getElementById('account-form').addEventListener('submit',function(e){
    e.preventDefault();
    var btn=document.getElementById('account-btn');
    var u=document.getElementById('account-username').value.trim();
    var p=document.getElementById('account-password').value;
    if(!u||!p){show('error','Username and password required');return}
    btn.disabled=true;btn.innerHTML=spinner()+' Signing in...';
    clr();
    var xhr=new XMLHttpRequest();
    xhr.open('POST',BACKEND+'/hotspot/verify',true);
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.timeout=15000;
    xhr.onload=function(){
      try{
        var data=JSON.parse(xhr.responseText);
        if(!data.success){show('error',data.error||'Invalid credentials');btn.disabled=false;btn.textContent='Sign in';return}
        show('success','Signed in! Connecting...');
        setTimeout(function(){submitMikrotik(data.username,data.password)},600);
      }catch(e){show('error','Server response error');btn.disabled=false;btn.textContent='Sign in'}
    };
    xhr.onerror=function(){show('error','Cannot reach server. Check connection.');btn.disabled=false;btn.textContent='Sign in'};
    xhr.ontimeout=function(){show('error','Server timeout.');btn.disabled=false;btn.textContent='Sign in'};
    xhr.send(JSON.stringify({username:u,password:p,routerApiKey:API_KEY,mac:MAC,ip:IP}));
  });

  // Show errors passed by MikroTik
  var err='$(error)';
  if(err&&err!=='$(error)'&&err!==''){show('error','Login failed: '+err);}

  // Load packages on startup
  loadPackages();
})();
</script>
</body>
</html>`;
    res.type('text/html').send(html);
  } catch (err) {
    res.status(500).type('text/plain').send('<!-- error: ' + (err instanceof Error ? err.message : 'unknown') + ' -->');
  }
});

export default router;

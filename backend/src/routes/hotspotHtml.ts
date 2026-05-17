import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma';

const router = Router();

// GET /hotspot-html/login?apiKey=xxx
// Returns the FULL captive portal HTML that will be stored locally on MikroTik
// as hotspot/login.html. Uses MikroTik template variables ($(var)) for context,
// and calls Dartbit backend ONLY for verification — no external redirects.
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

    // RouterOS template vars: $(if-error), $(mac), $(ip), $(link-login-only), $(error),
    // $(username), $(error-orig), $(link-orig)
    // These get expanded by MikroTik's hotspot httpd when serving login.html.
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WiFi Sign-in</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:20px}
.card{background:#fff;border-radius:20px;padding:32px 24px;max-width:420px;width:100%;box-shadow:0 25px 70px rgba(0,0,0,.25)}
.logo{text-align:center;font-size:24px;font-weight:900;color:#667eea;letter-spacing:2px;margin-bottom:4px}
.tagline{text-align:center;font-size:13px;color:#999;margin-bottom:24px}
.tabs{display:flex;gap:4px;margin-bottom:16px;background:#f3f4f6;padding:4px;border-radius:10px}
.tab{flex:1;padding:10px;text-align:center;font-size:14px;font-weight:600;color:#888;cursor:pointer;border-radius:8px;transition:all .2s}
.tab.active{background:#fff;color:#667eea;box-shadow:0 2px 6px rgba(0,0,0,.08)}
.panel{display:none}
.panel.active{display:block}
h2{font-size:17px;color:#222;margin-bottom:6px}
p.help{font-size:13px;color:#666;margin-bottom:18px;line-height:1.5}
label{display:block;font-size:11px;font-weight:600;color:#555;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
input{width:100%;padding:13px 16px;border:2px solid #e5e7eb;border-radius:12px;font-size:16px;outline:none;transition:border .2s;margin-bottom:12px}
input.code{letter-spacing:4px;text-transform:uppercase;text-align:center;font-weight:700;font-size:20px}
input:focus{border-color:#667eea}
button{width:100%;padding:13px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;transition:opacity .2s}
button:hover{opacity:.95}
button:disabled{opacity:.5;cursor:not-allowed}
.status{margin-top:14px;padding:11px 14px;border-radius:10px;font-size:13px;line-height:1.4;display:none}
.status.error{background:#fef2f2;color:#b91c1c;border:1px solid #fee2e2;display:block}
.status.success{background:#f0fdf4;color:#166534;border:1px solid #dcfce7;display:block}
.status.info{background:#eff6ff;color:#1e40af;border:1px solid #dbeafe;display:block}
.small{font-size:11px;color:#aaa;text-align:center;margin-top:18px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">${tenantName.toUpperCase()}</div>
  <div class="tagline">WiFi Sign-in</div>

  <div class="tabs">
    <div class="tab active" data-tab="voucher">Voucher</div>
    <div class="tab" data-tab="account">Account</div>
  </div>

  <div class="panel active" id="panel-voucher">
    <h2>Enter your voucher code</h2>
    <p class="help">Type the code from your ticket to access the WiFi.</p>
    <form id="voucher-form">
      <label>Voucher code</label>
      <input class="code" id="voucher-code" placeholder="XXXXXXXX" maxlength="16" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" required>
      <button type="submit" id="voucher-btn">Connect</button>
    </form>
  </div>

  <div class="panel" id="panel-account">
    <h2>Sign in with your account</h2>
    <p class="help">Use your existing username and password.</p>
    <form id="account-form">
      <label>Username</label>
      <input id="account-username" placeholder="Your username" autocomplete="username" autocapitalize="none" required>
      <label>Password</label>
      <input id="account-password" type="password" placeholder="Your password" autocomplete="current-password" required>
      <button type="submit" id="account-btn">Sign in</button>
    </form>
  </div>

  <div id="status" class="status"></div>
  <div class="small">Powered by Dartbit</div>
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
  var st=document.getElementById('status');

  function show(t,msg){st.className='status '+t;st.textContent=msg}
  function clr(){st.className='status';st.textContent=''}

  // Tab switching
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i++){
    tabs[i].addEventListener('click',function(){
      var name=this.getAttribute('data-tab');
      var allTabs=document.querySelectorAll('.tab');
      var allPanels=document.querySelectorAll('.panel');
      for(var j=0;j<allTabs.length;j++)allTabs[j].classList.remove('active');
      for(var k=0;k<allPanels.length;k++)allPanels[k].classList.remove('active');
      this.classList.add('active');
      document.getElementById('panel-'+name).classList.add('active');
      clr();
    });
  }

  // Submits credentials to MikroTik to activate session
  function submitMikrotik(username,password){
    document.getElementById('mt-username').value=username;
    document.getElementById('mt-password').value=password;
    document.getElementById('mikrotik-login').submit();
  }

  // Voucher flow - verify with backend, then submit to MikroTik
  document.getElementById('voucher-form').addEventListener('submit',function(e){
    e.preventDefault();
    var btn=document.getElementById('voucher-btn');
    var code=document.getElementById('voucher-code').value.toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(!code){show('error','Please enter a voucher code');return}
    btn.disabled=true;btn.textContent='Verifying...';
    clr();

    var xhr=new XMLHttpRequest();
    xhr.open('POST',BACKEND+'/hotspot/redeem',true);
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.timeout=15000;
    xhr.onload=function(){
      try{
        var data=JSON.parse(xhr.responseText);
        if(!data.success){
          show('error',data.error||'Invalid voucher');
          btn.disabled=false;btn.textContent='Connect';
          return;
        }
        show('success','Voucher accepted! Connecting...');
        setTimeout(function(){submitMikrotik(data.username,data.password)},600);
      }catch(err){
        show('error','Server response error');
        btn.disabled=false;btn.textContent='Connect';
      }
    };
    xhr.onerror=function(){
      show('error','Cannot reach server. Check connection.');
      btn.disabled=false;btn.textContent='Connect';
    };
    xhr.ontimeout=function(){
      show('error','Server timeout. Try again.');
      btn.disabled=false;btn.textContent='Connect';
    };
    xhr.send(JSON.stringify({code:code,routerApiKey:API_KEY,mac:MAC,ip:IP}));
  });

  // Account flow - verify with backend, then submit to MikroTik
  document.getElementById('account-form').addEventListener('submit',function(e){
    e.preventDefault();
    var btn=document.getElementById('account-btn');
    var u=document.getElementById('account-username').value.trim();
    var p=document.getElementById('account-password').value;
    if(!u||!p){show('error','Username and password required');return}
    btn.disabled=true;btn.textContent='Signing in...';
    clr();

    var xhr=new XMLHttpRequest();
    xhr.open('POST',BACKEND+'/hotspot/verify',true);
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.timeout=15000;
    xhr.onload=function(){
      try{
        var data=JSON.parse(xhr.responseText);
        if(!data.success){
          show('error',data.error||'Invalid credentials');
          btn.disabled=false;btn.textContent='Sign in';
          return;
        }
        show('success','Signed in! Connecting...');
        setTimeout(function(){submitMikrotik(data.username,data.password)},600);
      }catch(err){
        show('error','Server response error');
        btn.disabled=false;btn.textContent='Sign in';
      }
    };
    xhr.onerror=function(){
      show('error','Cannot reach server. Check connection.');
      btn.disabled=false;btn.textContent='Sign in';
    };
    xhr.ontimeout=function(){
      show('error','Server timeout. Try again.');
      btn.disabled=false;btn.textContent='Sign in';
    };
    xhr.send(JSON.stringify({username:u,password:p,routerApiKey:API_KEY,mac:MAC,ip:IP}));
  });

  // If MikroTik passed an error from a previous failed login, show it
  var err='$(error)';
  if(err&&err!=='$(error)'&&err!==''){show('error','Login failed: '+err);}
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

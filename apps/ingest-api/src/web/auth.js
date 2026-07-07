/* 网页登录（复用微信"暗号"能力 + JWT）——playground 与 dashboard 共用。
   流程：网页取暗号 XF-XXXX → 用户在公众号回复该暗号认领 → 网页轮询到 claimed → 兑换 JWT。
   JWT 存 localStorage，之后所有请求带 Authorization: Bearer；<img>/<a> 无法带头，用 ?token= 传。 */
(function () {
  var KEY = "xfeel_jwt";
  var MEDIA_KEY = "xfeel_media_jwt";
  var MEDIA_FOR_KEY = "xfeel_media_jwt_for"; // 记录这枚媒体 token 是给哪个会话 token 签发的
  var g = {};

  g.token = function () { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } };
  /**
   * 换身份（重新登录/admin token 覆盖）时必须连带清掉旧的媒体短 token——
   * 它是绑定着"上一个身份"的 family/scope 签发的，留着的话 mediaURL() 会一直
   * 优先用这个过期语义的旧 token，导致新身份能看的图片（比如 admin 该看的其它
   * 家庭）被旧 token 的家庭范围挡在外面，报 404「media not found」。
   */
  g.setToken = function (t) { try { localStorage.setItem(KEY, t); localStorage.removeItem(MEDIA_KEY); localStorage.removeItem(MEDIA_FOR_KEY); } catch (e) {} };
  g.clear = function () { try { localStorage.removeItem(KEY); localStorage.removeItem(MEDIA_KEY); localStorage.removeItem(MEDIA_FOR_KEY); } catch (e) {} };

  /** 退出登录：清空本地凭证并回到登录门。 */
  g.logout = function () { g.clear(); location.reload(); };

  function mediaToken() { try { return localStorage.getItem(MEDIA_KEY) || ""; } catch (e) { return ""; } };

  function tokenExpMs(t) {
    try {
      var body = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return (body.exp || 0) * 1000;
    } catch (e) { return 0; }
  }

  /**
   * 确保手里有一枚未过期、且是"给当前会话 token 签发"的媒体短 token（scope=media，只能读图）。
   * 只查过期时间不够：换了身份（admin token / 换个家庭重新登录）但旧媒体 token 还没过期时，
   * 会一直沿用旧身份范围的 token，导致新身份能看的图片被旧 token 的家庭范围挡在外面、
   * 返回 404——用 MEDIA_FOR_KEY 记录"这枚媒体 token 是给哪个会话 token 签的"，对不上就重取。
   */
  g.refreshMediaToken = function () {
    var t = mediaToken();
    var mintedFor = "";
    try { mintedFor = localStorage.getItem(MEDIA_FOR_KEY) || ""; } catch (e) {}
    if (t && mintedFor === g.token() && tokenExpMs(t) - Date.now() > 2 * 60 * 60 * 1000) return Promise.resolve(t);
    var sessionToken = g.token();
    return g.authFetch("/web/media-token").then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.token) {
        try { localStorage.setItem(MEDIA_KEY, res.token); localStorage.setItem(MEDIA_FOR_KEY, sessionToken); } catch (e) {}
        return res.token;
      }
      // admin：接口返回 token:null，继续用自己的 admin token；顺带清掉可能残留的旧媒体 token
      try { localStorage.removeItem(MEDIA_KEY); localStorage.removeItem(MEDIA_FOR_KEY); } catch (e) {}
      return "";
    }).catch(function () { return ""; });
  };

  /** 给 <img>/<a> 这类无法带请求头的 URL 追加 ?token=（优先媒体短 token）。 */
  g.mediaURL = function (path) {
    var t = mediaToken() || g.token();
    if (!t) return path;
    return path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(t);
  };

  /** 带 JWT 的 fetch；遇 401 清 token 并弹回登录门。 */
  g.authFetch = function (path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var t = g.token();
    if (t) headers["Authorization"] = "Bearer " + t;
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (r) {
      if (r.status === 401) { g.clear(); g.showGate(); throw new Error("未登录或登录已过期"); }
      return r;
    });
  };

  var onAuthed = null;
  var pollTimer = null;

  function jpost(path, body) {
    // 只有真的带 body 才声明 application/json——否则 Fastify 会因"空 body + JSON 头"报 400。
    var opts = { method: "POST" };
    if (body !== undefined && body !== null) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function jget(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  function ensureOverlay() {
    var el = document.getElementById("xfeel-auth-gate");
    if (el) return el;
    el = document.createElement("div");
    el.id = "xfeel-auth-gate";
    el.style.cssText =
      "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(5,9,18,.86);backdrop-filter:blur(6px);font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#e6edf6";
    el.innerHTML =
      '<div style="width:340px;max-width:92vw;background:#0f1729;border:1px solid #263247;border-radius:16px;' +
      'box-shadow:0 20px 60px -20px rgba(0,0,0,.7);padding:26px 24px;text-align:center">' +
      '<div style="font-size:17px;font-weight:700;margin-bottom:6px">登录 xfeel</div>' +
      '<div id="xfeel-auth-msg" style="color:#8a97ab;font-size:12.5px;margin-bottom:18px">用微信公众号确认身份即可登录</div>' +
      '<div id="xfeel-auth-code" style="display:none;margin:0 0 14px">' +
      '<div style="font-size:30px;font-weight:800;letter-spacing:3px;font-family:ui-monospace,Menlo,monospace;' +
      'color:#60a5fa;background:#0a1322;border:1px dashed #33425e;border-radius:12px;padding:14px 0"></div>' +
      '<div style="color:#8a97ab;font-size:12px;margin-top:10px">在公众号回复上面这串暗号，即可完成登录</div>' +
      '<div id="xfeel-auth-wait" style="color:#34d399;font-size:12px;margin-top:8px">⏳ 正在等待公众号确认…</div>' +
      "</div>" +
      '<button id="xfeel-auth-btn" style="width:100%;background:linear-gradient(180deg,#2563eb,#1d4ed8);color:#fff;' +
      "border:1px solid #3b6fe0;border-radius:10px;padding:11px 14px;font:inherit;font-weight:600;cursor:pointer\">获取登录暗号</button>" +
      '<div style="margin-top:20px;padding-top:18px;border-top:1px solid #263247">' +
      '<div style="color:#8a97ab;font-size:12px;margin-bottom:10px">首次使用请先扫码关注公众号</div>' +
      '<img src="/web/mp-qr.png" alt="公众号二维码" width="150" height="150" ' +
      'style="border-radius:10px;background:#fff;padding:6px;box-sizing:border-box" />' +
      '<div style="color:#c7d2e0;font-size:12.5px;font-weight:600;margin-top:8px">不吃辣联盟</div>' +
      "</div>" +
      "</div>";
    document.body.appendChild(el);
    el.querySelector("#xfeel-auth-btn").addEventListener("click", startLogin);
    return el;
  }

  function setMsg(text, color) {
    var m = document.getElementById("xfeel-auth-msg");
    if (m) { m.textContent = text; m.style.color = color || "#8a97ab"; }
  }

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function startLogin() {
    var overlay = ensureOverlay();
    var btn = overlay.querySelector("#xfeel-auth-btn");
    var codeBox = overlay.querySelector("#xfeel-auth-code");
    var codeEl = codeBox.querySelector("div");
    btn.disabled = true; btn.textContent = "获取中…";
    stopPoll();
    jpost("/web/login/start").then(function (res) {
      if (!res || !res.code) { setMsg("获取暗号失败，请重试", "#fb7185"); btn.disabled = false; btn.textContent = "重试"; return; }
      codeEl.textContent = res.code;
      codeBox.style.display = "block";
      setMsg("请在微信公众号回复下面的暗号 👇");
      btn.style.display = "none";
      pollTimer = setInterval(function () { pollStatus(res.code, overlay); }, 2500);
    }).catch(function () { setMsg("网络异常，请重试", "#fb7185"); btn.disabled = false; btn.textContent = "重试"; });
  }

  function pollStatus(code, overlay) {
    jget("/web/login/status?code=" + encodeURIComponent(code)).then(function (res) {
      var status = res && res.status;
      if (status === "claimed") {
        stopPoll();
        jpost("/web/login/redeem", { code: code }).then(function (r) {
          if (r && r.token) {
            g.setToken(r.token);
            teardown(overlay);
            if (onAuthed) onAuthed();
          } else {
            setMsg("兑换失败，请重新获取暗号", "#fb7185");
            resetToButton(overlay);
          }
        });
      } else if (status === "expired" || status === "used" || status === "not_found") {
        stopPoll();
        setMsg("暗号已失效，请重新获取", "#fb7185");
        resetToButton(overlay);
      }
    }).catch(function () { /* 轮询容忍瞬时错误 */ });
  }

  function resetToButton(overlay) {
    var btn = overlay.querySelector("#xfeel-auth-btn");
    overlay.querySelector("#xfeel-auth-code").style.display = "none";
    btn.style.display = "block"; btn.disabled = false; btn.textContent = "获取登录暗号";
  }

  function teardown(overlay) { stopPoll(); if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }

  g.showGate = function () { ensureOverlay().style.display = "flex"; };

  /**
   * URL 带 ?token=（admin token 或分享的会话 token）时，落进 localStorage 并把参数从
   * 地址栏擦掉（避免它留在浏览器历史/收藏夹里）。这是 g.ensureLogin 判断"是否已登录"
   * 之前必须先做的事——否则纯 URL token 从来不会被当成登录凭证。
   */
  function bootstrapTokenFromURL() {
    var params = new URLSearchParams(location.search);
    var t = params.get("token");
    if (!t) return;
    g.setToken(t);
    params.delete("token");
    var rest = params.toString();
    history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
  }

  /** 有 token 直接放行 cb；否则弹登录门，登录成功后再执行 cb。cb 前先备好媒体短 token。 */
  g.ensureLogin = function (cb) {
    bootstrapTokenFromURL();
    var run = cb ? function () { g.refreshMediaToken().then(function () { cb(); }); } : null;
    onAuthed = run;
    if (g.token()) { if (run) run(); }
    else { ensureOverlay(); }
  };

  window.XFEEL_AUTH = g;
})();

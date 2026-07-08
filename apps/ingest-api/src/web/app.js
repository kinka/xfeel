/* 家的记忆 · 用户端（/app）
   与 playground（管理调试台）分工：这里只呈现「日记/对话/回忆」，不暴露管线诊断。
   数据源：/web/me、/conversation/playground/diagnostics（当天对话+关联事件+图片）、
   /archive/daily（今日小结）、/memories/day（无对话历史日的记忆兜底）、/memories/calendar（日历亮点）。 */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var state = {
    me: null,
    ownerId: "",
    today: "",
    date: "",
    calMonth: "",           // 日历面板当前显示的月份 YYYY-MM
    calCache: {},           // ownerId|month -> days map
    loadSeq: 0,             // 防止旧请求覆盖新日期的渲染
    pendingImage: null,     // 已选待发的图片文件（配文后一起发）
  };

  // ===== 基础工具 =====
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function parseJSON(x, d) { try { return typeof x === "string" ? JSON.parse(x) : (x == null ? d : x); } catch (e) { return d; } }
  function api(path, opts) {
    opts = opts || {};
    if (opts.body && !opts.headers) opts.headers = { "Content-Type": "application/json" };
    return window.XFEEL_AUTH.authFetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || (path + " " + r.status));
        return data;
      });
    });
  }
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }
  function addDays(ymd, delta) {
    var d = new Date(ymd + "T00:00:00.000Z");
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }
  function hhmm(raw) {
    var s = String(raw || "");
    if (!s) return "";
    var d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" });
  }
  var WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  function dateTitle(ymd) {
    if (ymd === state.today) return "今天";
    if (ymd === addDays(state.today, -1)) return "昨天";
    if (ymd === addDays(state.today, -2)) return "前天";
    var d = new Date(ymd + "T00:00:00.000Z");
    var label = (d.getUTCMonth() + 1) + "月" + d.getUTCDate() + "日 周" + WEEKDAYS[d.getUTCDay()];
    return ymd.slice(0, 4) !== state.today.slice(0, 4) ? ymd.slice(0, 4) + "年" + label : label;
  }
  function mediaURL(id) { return window.XFEEL_AUTH.mediaURL("/media/" + encodeURIComponent(id)); }

  // ===== 头部：日期 / owner =====
  function renderHeader() {
    var sub = state.date === state.today ? "" : ' <span class="sub">' + esc(state.date.slice(5).replace("-", "/")) + "</span>";
    $("#dateTitle").innerHTML = esc(dateTitle(state.date)) + sub;
    $("#nextDay").disabled = state.date >= state.today;
    $("#nextDay").style.opacity = state.date >= state.today ? ".25" : "";
    $("#input").placeholder = state.date === state.today ? "记点什么，或问问过去…" : "补记到" + dateTitle(state.date) + "…";
    // 按人分池：看家人的记录时输入区只读（记录归属说话人本人，切回自己的视角再记）
    var me = state.me || {};
    var readonly = me.admin === false && me.self_owner_id && state.ownerId !== me.self_owner_id;
    document.querySelector(".composer").classList.toggle("readonly", !!readonly);
    var hint = $("#viewHint");
    if (readonly) {
      var label = (me.owners || []).filter(function (o) { return o.id === state.ownerId; })[0];
      hint.textContent = "正在看「" + (label ? label.label : "家人") + "」的记录 · 切回自己的视角可记录";
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
    var params = new URLSearchParams(location.search);
    params.set("owner_id", state.ownerId);
    params.set("date", state.date);
    history.replaceState(null, "", "?" + params.toString());
  }
  function renderOwnerSeg() {
    var owners = (state.me && state.me.owners) || [];
    var groups = (state.me && state.me.owner_groups) || [];
    var seg = $("#ownerSeg");
    if (owners.length < 2) { seg.hidden = true; return; }
    seg.hidden = false;
    function ownerBtn(o) {
      return '<button data-owner="' + esc(o.id) + '"' + (o.id === state.ownerId ? ' class="on"' : "") + ">" + esc(o.label) + "</button>";
    }
    if (groups.length > 1) {
      // admin 视角跨多个家庭：先选家庭，再在家庭内选成员，避免所有家庭成员挤成一长串。
      var currentGroup = currentFamilyGroup() || groups[0];
      seg.innerHTML = '<select class="family-select" id="familySelect" aria-label="选择家庭">' +
        groups.map(function (g) {
          return '<option value="' + esc(g.family_id) + '"' + (currentGroup && g.family_id === currentGroup.family_id ? " selected" : "") + ">" + esc(g.family_label) + "</option>";
        }).join("") + "</select>" +
        '<div class="seg-group">' + (currentGroup ? currentGroup.members.map(ownerBtn).join("") : "") + "</div>";
      $("#familySelect").addEventListener("change", function (e) {
        var g = groups.filter(function (item) { return item.family_id === e.target.value; })[0];
        if (!g || !g.members.length) return;
        state.ownerId = g.members[0].id;
        try { localStorage.setItem("xfeel_app_owner", state.ownerId); } catch (err) {}
        renderOwnerSeg();
        loadDay();
      });
    } else {
      seg.innerHTML = owners.map(ownerBtn).join("");
    }
    Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.owner === state.ownerId) return;
        state.ownerId = b.dataset.owner;
        try { localStorage.setItem("xfeel_app_owner", state.ownerId); } catch (e) {}
        renderOwnerSeg();
        loadDay();
      });
    });
  }
  function currentFamilyGroup() {
    var groups = (state.me && state.me.owner_groups) || [];
    for (var i = 0; i < groups.length; i++) {
      if ((groups[i].members || []).some(function (m) { return m.id === state.ownerId; })) return groups[i];
    }
    return null;
  }

  // ===== 信息流渲染 =====
  function eventChips(e) {
    var emo = parseJSON(e.emotion, {});
    var tags = parseJSON(e.tags, []);
    var chips = [];
    if (emo && emo.primary) {
      // 情绪 chip 按正负性上色（正绿/负蓝/中灰），强度高的加深
      var vcls = emo.valence ? " " + (MOOD_CLASS[emo.valence] || "").trim() : "";
      var strong = Number(emo.intensity) >= 0.7 ? " strong" : "";
      chips.push('<span class="chip emo' + vcls + strong + '"' +
        (emo.intensity ? ' title="强度 ' + esc(String(emo.intensity)) + '"' : "") + ">" + esc(emo.primary) + "</span>");
    }
    if (e.event_type && e.event_type !== "other") chips.push('<span class="chip">' + esc(e.event_type) + "</span>");
    (Array.isArray(tags) ? tags.slice(0, 3) : []).forEach(function (t) { chips.push('<span class="chip">' + esc(t) + "</span>"); });
    return chips.length ? '<div class="chips">' + chips.join("") + "</div>" : "";
  }
  function receiptHTML(events) {
    if (!events || !events.length) return "";
    return '<div class="receipts">' + events.map(function (e) {
      // 回执带情绪色：左边条按正负性上色，情绪词直接显示在摘要后
      var emo = parseJSON(e.emotion, {});
      var vcls = emo && emo.valence && MOOD_CLASS[emo.valence] ? " mood-" + MOOD_CLASS[emo.valence].trim() : "";
      var emoTag = emo && emo.primary ? '<span class="r-emo' + (vcls ? " " + vcls.trim().replace("mood-", "") : "") + '">' + esc(emo.primary) + "</span>" : "";
      return '<span class="receipt' + vcls + '" data-event-id="' + esc(e.id || "") + '">' +
        '<span class="ok" aria-label="已保存">✓</span><span class="r-sum">' + esc(e.summary || "") + "</span>" + emoTag +
        (e.id ? '<button class="r-x" title="删除这条记忆" aria-label="删除">✕</button>' : "") +
        "</span>";
    }).join("") + "</div>";
  }
  function recallCardsHTML(events) {
    if (!events || !events.length) return "";
    return '<div class="rc-label">相关记忆</div><div class="recall-cards">' + events.slice(0, 6).map(function (e) {
      var day = String(e.event_date || e.event_time || e.created_at || "").slice(0, 10);
      return '<div class="recall-card" data-goto="' + esc(day) + '">' +
        '<div class="rc-date">' + esc(day || "某天") + "</div>" +
        "<div>" + esc(e.summary || e.original_text || "") + "</div></div>";
    }).join("") + "</div>";
  }
  function bubbleHTML(turn) {
    var isUser = turn.role === "user";
    var photos = (turn.media || []).map(function (m) {
      return '<img class="b-img" loading="lazy" src="' + esc(mediaURL(m.id)) + '" alt="" />';
    }).join("");
    var receipts = isUser ? receiptHTML(turn.current_events) : "";
    var recalls = !isUser ? recallCardsHTML(turn.recalled_events) : "";
    var time = hhmm(turn.created_at);
    // 图片转写不是用户亲口说的话：渲染成照片下方的灰色说明，而不是用户气泡
    var isTranscript = isUser && turn.metadata && turn.metadata.image_transcript;
    var body = !turn.content ? "" : isTranscript
      ? '<div class="b-transcript">' + esc(turn.content) + "</div>"
      : '<div class="bubble">' + esc(turn.content) + "</div>";
    return '<div class="bubble-row ' + (isUser ? "user" : "assistant") + '">' +
      photos + body +
      receipts + recalls +
      (time ? '<div class="b-meta">' + esc(time) + "</div>" : "") +
      "</div>";
  }
  function dayCardHTML(archive) {
    if (!archive || !archive.summary || archive.status === "error") return "";
    return '<div class="day-card"><div class="dc-title">✦ 这一天的小结</div>' +
      '<div class="dc-body">' + esc(archive.summary) + "</div>" +
      '<div class="dc-meta">共 ' + (parseJSON(archive.event_ids, []) || []).length + " 条记忆</div></div>";
  }
  function memCardHTML(e) {
    var t = e.event_time ? hhmm(e.event_time) : "";
    var emo = parseJSON(e.emotion, {});
    var vcls = emo && emo.valence ? " mood-" + (MOOD_CLASS[emo.valence] || "").trim() : "";
    return '<div class="mem-card' + vcls + '"><div class="m-time">' + esc(t || "这一天") + "</div>" +
      '<div class="m-sum">' + esc(e.summary || "") + "</div>" + eventChips(e) +
      (e.original_text && e.original_text !== e.summary ? '<div class="m-orig">' + esc(e.original_text) + "</div>" : "") +
      "</div>";
  }
  function emptyHTML() {
    if (state.date === state.today) {
      return '<div class="empty"><div class="e-big">🌱</div>今天还没有记录<br/>把这一刻讲给我听吧</div>';
    }
    return '<div class="empty"><div class="e-big">🍂</div>这一天没有留下记录</div>';
  }

  // ===== 跟进关怀卡片 =====
  var CARE_ICONS = { echo: "💭", concern: "🤍", anticipation: "🗓" };
  function careCardHTML(item) {
    return '<div class="care-card" data-care-id="' + esc(item.id) + '">' +
      '<span class="c-icon">' + (CARE_ICONS[item.kind] || "💭") + "</span>" +
      '<div class="c-body">' + esc(item.content) + "</div>" +
      '<button class="c-x" title="知道了" aria-label="关闭">✕</button></div>';
  }
  /** 只在"今天"页顶部展示；关闭即 dismiss，微信侧也不会再问同一条。 */
  function loadCareCards() {
    if (state.date !== state.today || !state.ownerId) return;
    var owner = state.ownerId;
    api("/care/pending?owner_id=" + encodeURIComponent(owner)).then(function (res) {
      if (state.ownerId !== owner || state.date !== state.today) return;
      var items = (res && res.items) || [];
      if (!items.length) return;
      var feed = $("#feed");
      var empty = feed.querySelector(".empty");
      if (empty) empty.remove();
      feed.insertAdjacentHTML("afterbegin", items.map(careCardHTML).join(""));
      Array.prototype.forEach.call(feed.querySelectorAll(".care-card .c-x"), function (btn) {
        if (btn.dataset.bound) return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", function () {
          var card = btn.closest(".care-card");
          api("/care/dismiss", { method: "POST", body: JSON.stringify({ id: card.dataset.careId, owner_id: owner }) })
            .then(function () { card.remove(); })
            .catch(function () { card.remove(); });
        });
      });
    }).catch(function () {});
  }

  /** 当天事件情绪的客户端聚合：分布计数 + top 情绪词（事件抽取时就带了情绪，直接复用）。 */
  function dayMoodStripHTML(data) {
    var counts = { positive: 0, neutral: 0, negative: 0 };
    var freq = {};
    var total = 0;
    function take(e) {
      var emo = parseJSON(e.emotion, {});
      if (!emo || !emo.primary) return;
      var v = emo.valence === "positive" || emo.valence === "negative" ? emo.valence : "neutral";
      counts[v]++;
      total++;
      freq[emo.primary] = (freq[emo.primary] || 0) + 1;
    }
    (data.turns || []).forEach(function (t) { (t.current_events || []).forEach(take); });
    (data.memories || []).forEach(take);
    if (total < 2) return ""; // 只有一两条时 chip 本身已经够了，不值得占一行
    var top = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 3);
    return '<div class="day-mood"><span class="dm-label">这一天的情绪</span>' +
      '<span class="dm-bar">' + moodSegsHTML(counts) + "</span>" +
      '<span class="dm-top">' + esc(top.join(" · ")) + "</span></div>";
  }

  function renderDay(data) {
    var feed = $("#feed");
    var html = "";
    if (data.archive) html += dayCardHTML(data.archive);
    html += dayMoodStripHTML(data);
    if (data.turns.length) {
      html += data.turns.map(bubbleHTML).join("");
    } else if (data.memories.length) {
      html += '<div class="section-label">这一天的记忆</div>' + data.memories.map(memCardHTML).join("");
    }
    if (!html) html = emptyHTML();
    feed.innerHTML = html;
    bindFeedEvents();
    feed.scrollTop = data.turns.length ? feed.scrollHeight : 0;
  }

  /** 可重复调用：新插入的元素补绑事件，已绑过的（data-bound）跳过。 */
  function bindFeedEvents() {
    var feed = $("#feed");
    function fresh(selector) {
      return Array.prototype.filter.call(feed.querySelectorAll(selector), function (el) {
        if (el.dataset.bound) return false;
        el.dataset.bound = "1";
        return true;
      });
    }
    fresh(".mem-card").forEach(function (card) {
      card.addEventListener("click", function () { card.classList.toggle("open"); });
    });
    fresh(".recall-card").forEach(function (card) {
      card.addEventListener("click", function () {
        var day = card.dataset.goto;
        if (/^\d{4}-\d{2}-\d{2}$/.test(day || "")) { state.date = day; renderHeader(); loadDay(); }
      });
    });
    fresh(".b-img").forEach(function (img) {
      img.addEventListener("click", function () {
        $("#lightbox img").src = img.src;
        $("#lightbox").classList.add("show");
      });
    });
    fresh(".receipt .r-x").forEach(function (btn) {
      btn.addEventListener("click", function () { armReceiptDelete(btn.closest(".receipt")); });
    });
  }

  /**
   * 自然语言消息的抽取在后台异步进行（回复先返回，事件之后才落库、回填 turn metadata），
   * 所以回执不能只看发送响应：按 turn id 轮询当天 diagnostics，看到 current_events 就补挂。
   * pipeline 终结（indexed/done）仍无事件 = 被判定为闲聊不入库，安静收手。
   */
  function watchReceipt(userRow, turnId) {
    if (!turnId) return;
    var owner = state.ownerId, day = state.date;
    var delays = [2000, 3000, 5000, 8000, 13000];
    var i = 0;
    function next() { if (i < delays.length) setTimeout(check, delays[i++]); }
    function check() {
      if (!userRow.isConnected) return; // 已切日期/重渲染：canonical 数据自带回执，不用补
      api("/conversation/playground/diagnostics?owner_id=" + encodeURIComponent(owner) + "&date=" + encodeURIComponent(day) + "&limit=200").then(function (res) {
        var turn = (res.diagnostics || []).filter(function (t) { return t.turn_id === turnId; })[0];
        var events = (turn && turn.current_events) || [];
        if (events.length) {
          if (userRow.isConnected && !userRow.querySelector(".receipts")) {
            userRow.insertAdjacentHTML("beforeend", receiptHTML(events));
            bindFeedEvents();
          }
          return;
        }
        var settled = turn && turn.pipeline && turn.pipeline.stage === "indexed" && turn.pipeline.status !== "pending";
        if (!settled) next();
      }).catch(next);
    }
    next();
  }

  /** 回执上的删除：第一次点 ✕ 变成「确认删除」，3 秒不点自动还原。 */
  function armReceiptDelete(receipt) {
    if (!receipt || receipt.querySelector(".r-confirm")) return;
    var x = receipt.querySelector(".r-x");
    x.hidden = true;
    var confirmBtn = document.createElement("button");
    confirmBtn.className = "r-confirm";
    confirmBtn.textContent = "确认删除";
    receipt.appendChild(confirmBtn);
    var timer = setTimeout(function () { confirmBtn.remove(); x.hidden = false; }, 3000);
    confirmBtn.addEventListener("click", function () {
      clearTimeout(timer);
      confirmBtn.disabled = true;
      api("/events/delete", { method: "POST", body: JSON.stringify({ event_id: receipt.dataset.eventId }) })
        .then(function () { receipt.remove(); toast("已删除这条记忆"); })
        .catch(function (e) { toast("删除失败：" + e.message); confirmBtn.remove(); x.hidden = false; });
    });
  }

  // ===== 数据加载 =====
  function loadDay() {
    var seq = ++state.loadSeq;
    var owner = state.ownerId, day = state.date;
    renderHeader();
    $("#feed").innerHTML = '<div class="empty"><div class="typing"><i></i><i></i><i></i></div></div>';
    var qs = "owner_id=" + encodeURIComponent(owner) + "&date=" + encodeURIComponent(day);
    return Promise.all([
      api("/conversation/playground/diagnostics?" + qs + "&limit=200"),
      api("/archive/daily?" + qs).catch(function () { return {}; }),
    ]).then(function (res) {
      var turns = (res[0] && res[0].diagnostics) || [];
      var archive = ((res[1] && res[1].archives) || [])[0] || null;
      var next = { turns: turns, archive: archive, memories: [] };
      if (turns.length) return next;
      // 没有对话的历史日：用长期记忆兜底渲染
      return api("/memories/day?" + qs).then(function (m) {
        next.memories = (m && m.events) || [];
        return next;
      }).catch(function () { return next; });
    }).then(function (data) {
      if (seq !== state.loadSeq) return; // 期间用户又切了日期/owner
      renderDay(data);
      loadCareCards();
    }).catch(function (e) {
      if (seq !== state.loadSeq) return;
      $("#feed").innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
  }

  // ===== 发送 =====
  function appendBubble(html) {
    var feed = $("#feed");
    var empty = feed.querySelector(".empty");
    if (empty) empty.remove();
    feed.insertAdjacentHTML("beforeend", html);
    feed.scrollTop = feed.scrollHeight;
    return feed.lastElementChild;
  }
  function appendTyping() {
    return appendBubble('<div class="bubble-row assistant"><div class="bubble typing"><i></i><i></i><i></i></div></div>');
  }

  /** 发送按钮统一分发：有待发图片则图文一起走上传，否则纯文本。 */
  function handleSend() {
    if (state.pendingImage) {
      var note = $("#input").value.trim();
      var file = state.pendingImage;
      clearPendingImage();
      $("#input").value = "";
      autosize();
      sendImage(file, note);
      return;
    }
    sendText();
  }

  function setPendingImage(file) {
    if (!file) return;
    state.pendingImage = file;
    var thumb = $("#imgPreviewThumb");
    if (thumb.src) URL.revokeObjectURL(thumb.src);
    thumb.src = URL.createObjectURL(file);
    $("#imgPreview").hidden = false;
    $("#input").placeholder = "给这张照片配句话（可不填）…";
    $("#input").focus();
  }
  function clearPendingImage() {
    state.pendingImage = null;
    $("#imgPreview").hidden = true;
    $("#imgInput").value = "";
    renderHeader(); // 恢复 placeholder
  }

  function sendText() {
    var input = $("#input");
    var text = input.value.trim();
    if (!text || sendText._busy) return;
    sendText._busy = true;
    $("#sendBtn").disabled = true;
    input.value = "";
    autosize();
    var userRow = appendBubble('<div class="bubble-row user"><div class="bubble">' + esc(text) + "</div></div>");
    var typingRow = appendTyping();
    api("/conversation/message", {
      method: "POST",
      body: JSON.stringify({ text: text, owner_id: state.ownerId, date: state.date }),
    }).then(function (data) {
      typingRow.remove();
      if (data.reply) {
        var events = data.intent === "log" ? [] : (data.events || []);
        appendBubble('<div class="bubble-row assistant"><div class="bubble">' + esc(data.reply) + "</div>" + recallCardsHTML(events) + "</div>");
      }
      // 记忆回执：显式「记：」路径抽取同步返回，直接挂；自然语言路径异步入库，轮询补挂
      var stored = data.intent === "log" && data.result && data.result.pipeline ? (data.result.pipeline.events || []) : [];
      if (stored.length) {
        userRow.insertAdjacentHTML("beforeend", receiptHTML(stored));
        bindFeedEvents();
      } else if (data.intent === "chat") {
        watchReceipt(userRow, data.result && data.result.user_turn && data.result.user_turn.id);
      }
      // 归档/撤销/修正会改动当天数据，整天重拉一次保持一致
      if (data.intent === "archive" || data.intent === "undo" || data.intent === "correct") loadDay();
      $("#feed").scrollTop = $("#feed").scrollHeight;
    }).catch(function (e) {
      typingRow.remove();
      userRow.classList.add("failed");
      userRow.insertAdjacentHTML("beforeend", '<div class="b-meta">发送失败，点击气泡重试</div>');
      userRow.querySelector(".bubble").addEventListener("click", function () {
        userRow.remove();
        input.value = text;
        autosize();
        sendText();
      }, { once: true });
      toast("发送失败：" + e.message);
    }).then(function () {
      sendText._busy = false;
      $("#sendBtn").disabled = false;
    });
  }

  // ===== 图片上传 =====
  /** 压到长边 maxSide、JPEG q=0.85，避免整张原图 base64 撑爆请求。 */
  function compressImage(file, maxSide) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("图片读取失败")); };
      img.src = url;
    });
  }

  function sendImage(file, note) {
    if (!file || sendImage._busy) return;
    sendImage._busy = true;
    var previewURL = URL.createObjectURL(file);
    // 配文是用户亲口说的话（正常气泡）；转写稍后以灰色说明样式补上
    var userRow = appendBubble('<div class="bubble-row user"><img class="b-img" src="' + esc(previewURL) + '" alt="" />' +
      (note ? '<div class="bubble">' + esc(note) + "</div>" : "") +
      '<div class="b-meta">转写中…</div></div>');
    var typingRow = appendTyping();
    compressImage(file, 1600).then(function (dataUrl) {
      return api("/web/upload/image", {
        method: "POST",
        body: JSON.stringify({ image_base64: dataUrl, mime: "image/jpeg", owner_id: state.ownerId, date: state.date, note: note || undefined }),
      });
    }).then(function (data) {
      typingRow.remove();
      var meta = userRow.querySelector(".b-meta");
      if (meta) meta.remove();
      if (data.caption) userRow.insertAdjacentHTML("beforeend", '<div class="b-transcript">' + esc(data.caption) + "</div>");
      if (data.reply) appendBubble('<div class="bubble-row assistant"><div class="bubble">' + esc(data.reply) + "</div></div>");
      // 上传接口的 result 是 ProductMessageResult（里面再嵌一层 ChatResult/LogResult）
      var inner = (data.result && data.result.result) || {};
      var stored = inner.pipeline ? (inner.pipeline.events || []) : [];
      if (stored.length) { userRow.insertAdjacentHTML("beforeend", receiptHTML(stored)); bindFeedEvents(); }
      else if (inner.user_turn) { watchReceipt(userRow, inner.user_turn.id); }
    }).catch(function (e) {
      typingRow.remove();
      userRow.classList.add("failed");
      toast("图片发送失败：" + e.message);
    }).then(function () {
      sendImage._busy = false;
    });
  }

  // ===== 日历 =====
  function calendarData(month) {
    var key = state.ownerId + "|" + month;
    if (state.calCache[key]) return Promise.resolve(state.calCache[key]);
    return api("/memories/calendar?owner_id=" + encodeURIComponent(state.ownerId) + "&month=" + encodeURIComponent(month))
      .then(function (res) {
        state.calCache[key] = { days: res.days || {}, moods: res.moods || {} };
        return state.calCache[key];
      })
      .catch(function () { return { days: {}, moods: {} }; });
  }
  var MOOD_CLASS = { positive: " pos", negative: " neg", neutral: " neu" };
  /** 正/中/负三段的堆叠段 HTML（flex 按计数分宽），日历迷你条和当天分布条共用。 */
  function moodSegsHTML(m) {
    return ["positive", "neutral", "negative"].map(function (v) {
      var n = m[v] || 0;
      if (!n) return "";
      return '<i class="' + MOOD_CLASS[v].trim() + '" style="flex:' + n + '"></i>';
    }).join("");
  }
  function renderCalendar() {
    var month = state.calMonth;
    $("#calTitle").textContent = month.slice(0, 4) + "年" + Number(month.slice(5)) + "月";
    $("#calNext").disabled = month >= state.today.slice(0, 7);
    calendarData(month).then(function (cal) {
      if (state.calMonth !== month) return;
      var days = cal.days, moods = cal.moods;
      var first = new Date(month + "-01T00:00:00.000Z");
      var startWd = first.getUTCDay(); // 周日=0
      var daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      var html = WEEKDAYS.map(function (w) { return '<div class="wd">' + w + "</div>"; }).join("");
      for (var i = 0; i < startWd; i++) html += "<div></div>";
      for (var d = 1; d <= daysInMonth; d++) {
        var ymd = month + "-" + String(d).padStart(2, "0");
        var count = days[ymd] || 0;
        var cls = "cal-day" + (ymd === state.date ? " sel" : "") + (ymd === state.today ? " today" : "");
        var future = ymd > state.today;
        // 情绪分布迷你条：当天正/中/负比例一眼可见；无情绪数据时退回数量点
        var mood = moods[ymd];
        var marker = "";
        var tip = "";
        if (mood && mood.total) {
          marker = '<span class="mini-mood">' + moodSegsHTML(mood) + "</span>";
          tip = ' title="' + esc((mood.top || [mood.emotion]).join("、") + " · 正" + mood.positive + " 中" + mood.neutral + " 负" + mood.negative) + '"';
        } else if (count) {
          marker = '<span class="dot' + (count >= 5 ? " big" : "") + '"></span>';
        }
        html += '<button class="' + cls + '" data-day="' + ymd + '"' + (future ? " disabled" : "") + tip + ">" + d + marker + "</button>";
      }
      $("#calGrid").innerHTML = html;
      Array.prototype.forEach.call($("#calGrid").querySelectorAll(".cal-day:not(:disabled)"), function (b) {
        b.addEventListener("click", function () {
          state.date = b.dataset.day;
          $("#calMask").classList.remove("show");
          renderHeader();
          loadDay();
        });
      });
    });
  }

  // ===== 成长里程碑 =====
  function openMilestones() {
    var owner = state.ownerId;
    $("#msBody").innerHTML = '<div class="ms-empty"><div class="typing"><i></i><i></i><i></i></div></div>';
    $("#msMask").classList.add("show");
    loadMilestones(owner, 0);
  }
  function loadMilestones(owner, attempt) {
    api("/milestones?owner_id=" + encodeURIComponent(owner)).then(function (res) {
      if (state.ownerId !== owner) return;
      // stale：旧快照先展示，服务端正在后台重新策展；面板还开着就过几秒静默换新
      if (res && res.stale && attempt < 2) {
        setTimeout(function () {
          if ($("#msMask").classList.contains("show") && state.ownerId === owner) loadMilestones(owner, attempt + 1);
        }, 6000);
      }
      var items = (res && res.milestones) || [];
      if (!items.length) {
        $("#msBody").innerHTML = '<div class="ms-empty">还没有记下里程碑<br/>「第一次」的瞬间都会收进这里</div>';
        return;
      }
      var html = "";
      var year = "";
      items.forEach(function (m) {
        var y = String(m.date || "").slice(0, 4);
        if (y && y !== year) {
          if (year) html += "</div>";
          html += '<div class="ms-year">' + esc(y) + '年</div><div class="ms-line">';
          year = y;
        }
        html += '<div class="ms-item" data-goto="' + esc(m.date || "") + '">' +
          '<div class="ms-date">' + esc(String(m.date || "").slice(5).replace("-", "/")) + "</div>" +
          '<div class="ms-sum">' + esc(m.summary || "") + "</div></div>";
      });
      if (year) html += "</div>";
      $("#msBody").innerHTML = html;
      Array.prototype.forEach.call($("#msBody").querySelectorAll(".ms-item"), function (el) {
        el.addEventListener("click", function () {
          var day = el.dataset.goto;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) return;
          $("#msMask").classList.remove("show");
          state.date = day; renderHeader(); loadDay();
        });
      });
    }).catch(function (e) {
      $("#msBody").innerHTML = '<div class="ms-empty">加载失败：' + esc(e.message) + "</div>";
    });
  }

  // ===== 情绪回顾 =====
  var VALENCE_LABEL = { positive: "偏晴", negative: "偏阴", neutral: "平平" };
  function openMoodReview() {
    var owner = state.ownerId;
    $("#moodBody").innerHTML = '<div class="ms-empty"><div class="typing"><i></i><i></i><i></i></div></div>';
    $("#moodMask").classList.add("show");
    api("/emotions/review?owner_id=" + encodeURIComponent(owner) + "&days=30").then(function (r) {
      if (state.ownerId !== owner) return;
      if (!r.total) {
        $("#moodBody").innerHTML = '<div class="ms-empty">' + esc(r.narrative || "还没有情绪记录") + "</div>";
        return;
      }
      var v = r.valence;
      var pctPos = Math.round(v.positive / r.total * 100);
      var pctNeg = Math.round(v.negative / r.total * 100);
      var pctNeu = Math.max(0, 100 - pctPos - pctNeg);
      var maxTop = r.top.length ? r.top[0].count : 1;
      var maxWeek = 1;
      r.weeks.forEach(function (w) { maxWeek = Math.max(maxWeek, w.total); });
      var html =
        '<div class="mood-narrative">' + esc(r.narrative || "") + "</div>" +
        '<div class="mood-ratio"><i class="pos" style="width:' + pctPos + '%"></i><i class="neu" style="width:' + pctNeu + '%"></i><i class="neg" style="width:' + pctNeg + '%"></i></div>' +
        '<div class="mood-ratio-legend"><span><i class="dot-pos"></i>晴 ' + pctPos + "%</span><span><i class=\"dot-neu\"></i>平 " + pctNeu + "%</span><span><i class=\"dot-neg\"></i>阴 " + pctNeg + "%</span></div>" +
        '<div class="mood-sec">常出现的情绪</div>' +
        r.top.map(function (t) {
          var w = Math.max(8, Math.round(t.count / maxTop * 100));
          return '<div class="mood-row"><span class="mr-name">' + esc(t.emotion) + '</span><span class="mr-bar"><i class="' + (MOOD_CLASS[t.valence] || "").trim() + '" style="width:' + w + '%"></i></span><span class="mr-count">' + t.count + "</span></div>";
        }).join("") +
        '<div class="mood-sec">按周走势</div>' +
        '<div class="mood-weeks">' + r.weeks.map(function (w) {
          var h = Math.max(4, Math.round(w.total / maxWeek * 56));
          var posH = w.total ? Math.round(h * w.positive / w.total) : 0;
          var negH = w.total ? Math.round(h * w.negative / w.total) : 0;
          var neuH = Math.max(0, h - posH - negH);
          return '<div class="mw-col" title="' + esc(w.from.slice(5) + "~" + w.to.slice(5)) + '">' +
            '<div class="mw-bar" style="height:56px"><i class="neg" style="height:' + negH + 'px"></i><i class="neu" style="height:' + neuH + 'px"></i><i class="pos" style="height:' + posH + 'px"></i></div>' +
            '<div class="mw-label">' + esc(String(Number(w.to.slice(5, 7))) + "/" + Number(w.to.slice(8))) + "</div></div>";
        }).join("") + "</div>";
      $("#moodBody").innerHTML = html;
    }).catch(function (e) {
      $("#moodBody").innerHTML = '<div class="ms-empty">加载失败：' + esc(e.message) + "</div>";
    });
  }

  // ===== 家庭资料 =====
  var LABEL_PRESETS = ["爸爸", "妈妈", "爷爷", "奶奶", "外公", "外婆"];
  function openLabelSheet() {
    var isAdmin = state.me && state.me.admin;
    var group = isAdmin ? currentFamilyGroup() : null;
    var box = $("#labelPresets");
    box.innerHTML = LABEL_PRESETS.map(function (l) { return "<button data-label=\"" + l + "\">" + l + "</button>"; }).join("");
    var currentLabel = state.me && state.me.speaker_label;
    Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) {
      if (b.dataset.label === currentLabel) b.classList.add("on");
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(box.querySelectorAll("button"), function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        $("#labelInput").value = "";
      });
    });
    $("#familyNameInput").value = isAdmin ? ((group && (group.family_name || group.family_label)) || "") : ((state.me && state.me.family_name) || "");
    $("#labelInput").value = "";
    box.hidden = !!isAdmin;
    $("#labelInput").hidden = !!isAdmin;
    var labelField = box.previousElementSibling;
    if (labelField) labelField.hidden = !!isAdmin;
    $("#labelSkip").hidden = !!isAdmin;
    $("#labelSave").textContent = isAdmin ? "保存家庭名称" : "就这么叫";
    $("#labelMask").classList.add("show");
  }
  function chosenLabel() {
    var typed = $("#labelInput").value.trim();
    if (typed) return typed;
    var on = $("#labelPresets button.on");
    return on ? on.dataset.label : "";
  }
  function saveLabel() {
    var isAdmin = state.me && state.me.admin;
    var group = isAdmin ? currentFamilyGroup() : null;
    var familyName = $("#familyNameInput").value.trim().replace(/\s+/g, " ");
    var label = isAdmin ? "" : chosenLabel();
    if (!familyName && !label) { toast("先填写家庭名称，或选一个称呼"); return; }
    if (familyName && !/^[一-龥A-Za-z0-9· _-]{1,20}$/.test(familyName)) { toast("家庭名称需为 1-20 个汉字、字母或数字"); return; }
    if (label && !/^[一-龥A-Za-z·]{1,8}$/.test(label)) { toast("称呼需为 1-8 个汉字或字母"); return; }
    $("#labelSave").disabled = true;
    var calls = [];
    var currentFamilyName = isAdmin ? (group && (group.family_name || group.family_label)) : ((state.me && state.me.family_name) || "");
    if (familyName && familyName !== (currentFamilyName || "")) {
      calls.push(api("/web/profile/family", {
        method: "POST",
        body: JSON.stringify(isAdmin ? { name: familyName, family_id: group && group.family_id } : { name: familyName }),
      }));
    }
    if (label && label !== (state.me && state.me.speaker_label)) {
      calls.push(api("/web/profile/self", { method: "POST", body: JSON.stringify({ label: label }) }));
    }
    Promise.all(calls).then(function () {
      $("#labelMask").classList.remove("show");
      toast("资料已保存");
      // 称呼影响 owner 列表与身份行：重拉 /web/me 刷新界面
      return refreshMe();
    }).catch(function (e) {
      toast("没保存上：" + e.message);
    }).then(function () { $("#labelSave").disabled = false; });
  }

  function profileLine(me) {
    var parts = [];
    if (me.family_name) parts.push("家庭：" + me.family_name);
    if (me.speaker_label) parts.push("当前身份：" + me.speaker_label);
    if (me.admin) parts.push("管理员");
    return parts.length ? parts.join(" · ") : "已登录";
  }

  function refreshMe() {
    return api("/web/me").then(function (me) {
      state.me = me;
      $("#menuWho").textContent = profileLine(me);
      renderOwnerSeg();
      renderHeader();
      return me;
    });
  }

  // ===== 输入框 =====
  function autosize() {
    var input = $("#input");
    input.style.height = "auto";
    var minHeight = parseFloat(getComputedStyle(input).minHeight) || 0;
    input.style.height = Math.max(minHeight, Math.min(input.scrollHeight, 132)) + "px";
  }

  // ===== 事件绑定 =====
  function bindUI() {
    $("#prevDay").addEventListener("click", function () { state.date = addDays(state.date, -1); renderHeader(); loadDay(); });
    $("#nextDay").addEventListener("click", function () {
      if (state.date >= state.today) return;
      state.date = addDays(state.date, 1); renderHeader(); loadDay();
    });
    $("#dateBtn").addEventListener("click", function () {
      state.calMonth = state.date.slice(0, 7);
      $("#calMask").classList.add("show");
      renderCalendar();
    });
    $("#calPrev").addEventListener("click", function () { state.calMonth = addDays(state.calMonth + "-15", -30).slice(0, 7); renderCalendar(); });
    $("#calNext").addEventListener("click", function () { state.calMonth = addDays(state.calMonth + "-15", 30).slice(0, 7); renderCalendar(); });
    $("#menuBtn").addEventListener("click", function () { $("#menuMask").classList.add("show"); });
    $("#milestoneBtn").addEventListener("click", function () {
      $("#menuMask").classList.remove("show");
      openMilestones();
    });
    $("#moodBtn").addEventListener("click", function () {
      $("#menuMask").classList.remove("show");
      openMoodReview();
    });
    [["#calMask"], ["#menuMask"], ["#msMask"], ["#moodMask"]].forEach(function (pair) {
      var mask = $(pair[0]);
      mask.addEventListener("click", function (e) { if (e.target === mask) mask.classList.remove("show"); });
    });
    $("#gotoToday").addEventListener("click", function () {
      $("#menuMask").classList.remove("show");
      state.date = state.today; renderHeader(); loadDay();
    });
    $("#logoutBtn").addEventListener("click", function () { window.XFEEL_AUTH.logout(); });
    $("#lightbox").addEventListener("click", function () { $("#lightbox").classList.remove("show"); });
    $("#setLabelBtn").addEventListener("click", function () {
      $("#menuMask").classList.remove("show");
      openLabelSheet();
    });
    $("#labelSave").addEventListener("click", saveLabel);
    $("#labelSkip").addEventListener("click", function () {
      $("#labelMask").classList.remove("show");
      try { localStorage.setItem("xfeel_label_prompt_skipped", "1"); } catch (e) {}
    });
    var labelMask = $("#labelMask");
    labelMask.addEventListener("click", function (e) { if (e.target === labelMask) labelMask.classList.remove("show"); });
    $("#labelInput").addEventListener("input", function () {
      Array.prototype.forEach.call($("#labelPresets").querySelectorAll("button"), function (x) { x.classList.remove("on"); });
    });

    $("#sendBtn").addEventListener("click", handleSend);
    var input = $("#input");
    input.addEventListener("input", autosize);
    input.addEventListener("focus", function () {
      input.classList.add("expanded");
      autosize();
    });
    input.addEventListener("blur", function () {
      if (!input.value.trim()) input.classList.remove("expanded");
      autosize();
    });
    // 桌面端 Enter 直接发送；手机上 Enter 换行（软键盘发送用按钮）
    if (window.matchMedia("(pointer: fine)").matches) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleSend(); }
      });
    }
    $("#imgBtn").addEventListener("click", function () { $("#imgInput").click(); });
    // 选图后先进入「配文」态：预览 + 可选配一句话，点发送才上传
    $("#imgInput").addEventListener("change", function () { setPendingImage($("#imgInput").files[0]); });
    $("#imgCancel").addEventListener("click", clearPendingImage);
  }

  // ===== 启动 =====
  function init() {
    api("/web/me").then(function (me) {
      state.me = me;
      state.today = me.today || new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
      var params = new URLSearchParams(location.search);
      var owners = me.owners || [];
      var saved = "";
      try { saved = localStorage.getItem("xfeel_app_owner") || ""; } catch (e) {}
      var want = params.get("owner_id") || saved;
      state.ownerId = owners.some(function (o) { return o.id === want; }) ? want : (owners[0] ? owners[0].id : "");
      var d = params.get("date");
      state.date = /^\d{4}-\d{2}-\d{2}$/.test(d || "") && d <= state.today ? d : state.today;
      $("#menuWho").textContent = profileLine(me);
      $("#menuAdmin").hidden = !me.admin;
      $("#setLabelBtn").hidden = false;
      renderOwnerSeg();
      renderHeader();
      if (!state.ownerId) {
        $("#feed").innerHTML = '<div class="empty">还没有绑定家庭成员<br/>请先在微信里发一条消息完成初始化</div>';
        return;
      }
      loadDay();
      // 占位「本人」用户首次进入：引导设置称呼（跳过一次后不再自动弹，菜单里随时可改）
      var skipped = "";
      try { skipped = localStorage.getItem("xfeel_label_prompt_skipped") || ""; } catch (e) {}
      if (me.onboarding_stage === "auto" && !skipped) setTimeout(openLabelSheet, 600);
    }).catch(function (e) {
      $("#feed").innerHTML = '<div class="empty">加载身份失败：' + esc(e.message) + "</div>";
    });
  }

  bindUI();
  window.XFEEL_AUTH.ensureLogin(init);
})();

(() => {
  "use strict";

  // =========================================================
  // 1. IndexedDB Local Vault (Anti-Delete Messages + Files)
  // =========================================================
  const LocalVault = {
    db: null,
    DB_NAME: "GhostGramLocalVault",
    DB_VERSION: 1,

    async init() {
      if (this.db) return this.db;
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains("messages")) {
            const msgStore = db.createObjectStore("messages", { keyPath: "id" });
            msgStore.createIndex("chat_id", "chat_id", { unique: false });
          }
          if (!db.objectStoreNames.contains("files")) {
            db.createObjectStore("files", { keyPath: "file_id" });
          }
        };
        req.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(this.db);
        };
        req.onerror = () => reject(req.error);
      });
    },

    async putMessage(msg) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readwrite");
        const store = tx.objectStore("messages");
        const getReq = store.get(msg.id);
        getReq.onsuccess = () => {
          const existing = getReq.result || {};
          const merged = {
            ...existing,
            ...msg,
            locally_deleted: existing.locally_deleted || Boolean(msg.locally_deleted),
            deleted_at: msg.deleted_at || existing.deleted_at || null,
            saved_at: existing.saved_at || Date.now(),
          };
          store.put(merged);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async markDeleted(messageId, deletedAt) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readwrite");
        const store = tx.objectStore("messages");
        const getReq = store.get(messageId);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (existing) {
            existing.locally_deleted = true;
            existing.deleted_at = deletedAt || Math.floor(Date.now() / 1000);
            store.put(existing);
            tx.oncomplete = () => resolve(existing);
          } else {
            tx.oncomplete = () => resolve(null);
          }
        };
        tx.onerror = () => reject(tx.error);
      });
    },

    async getChatMessages(chatId) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readonly");
        const idx = tx.objectStore("messages").index("chat_id");
        const req = idx.getAll(Number(chatId));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },

    async getDeletedMessages() {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readonly");
        const req = tx.objectStore("messages").getAll();
        req.onsuccess = () => {
          const all = (req.result || []).filter((m) => m.locally_deleted);
          all.sort((a, b) => (b.deleted_at || b.created_at) - (a.deleted_at || a.created_at));
          resolve(all);
        };
        req.onerror = () => reject(req.error);
      });
    },

    async putFile(fileId, fileName, fileMime, blob) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put({
          file_id: fileId,
          file_name: fileName,
          file_mime: fileMime || blob.type || "application/octet-stream",
          file_size: blob.size,
          blob,
          saved_at: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async getFile(fileId) {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("files", "readonly");
        const req = tx.objectStore("files").get(fileId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },

    async getAllFiles() {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("files", "readonly");
        const req = tx.objectStore("files").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },

    async clearAll() {
      const db = await this.init();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(["messages", "files"], "readwrite");
        tx.objectStore("messages").clear();
        tx.objectStore("files").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  // =========================================================
  // 2. App State
  // =========================================================
  const state = {
    token: localStorage.getItem("gg_token") || "",
    user: null,
    chats: [],
    activeChatId: null,
    messagesByChat: {},
    liveDrafts: {}, // { chatId: { userId: { display_name, text, ts } } }
    blobUrlCache: {}, // { fileId: objectURL }
    antiDelete: localStorage.getItem("gg_anti_delete") !== "0",
    theme: localStorage.getItem("gg_theme") || "dark",
    authMode: "login",
    replyTo: null,
    editingMsg: null,
    pendingFile: null,
    inChatSearch: "",
    groupSelectedUsers: new Map(),
    ws: null,
    wsReconnectTimer: null,
    pingTimer: null,
    lastDraftSentAt: 0,
    draftThrottleTimer: null,
  };

  const $ = (id) => document.getElementById(id);

  // =========================================================
  // 3. Helpers
  // =========================================================
  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function initials(name) {
    return (name || "?").trim().slice(0, 2).toUpperCase();
  }

  function showToast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.hidden = true;
    }, 3000);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) {
      headers["Authorization"] = `Bearer ${state.token}`;
    }
    if (options.body && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || "Xatolik yuz berdi");
    }
    return data;
  }

  async function cacheFileLocally(msg) {
    if (!state.antiDelete || !msg.file_id || !msg.file_url) return;
    try {
      const existing = await LocalVault.getFile(msg.file_id);
      if (existing) {
        if (!state.blobUrlCache[msg.file_id]) {
          state.blobUrlCache[msg.file_id] = URL.createObjectURL(existing.blob);
        }
        return;
      }
      const res = await fetch(msg.file_url);
      if (!res.ok) return;
      const blob = await res.blob();
      await LocalVault.putFile(msg.file_id, msg.file_name || "file", msg.file_mime || blob.type, blob);
      state.blobUrlCache[msg.file_id] = URL.createObjectURL(blob);
    } catch (_) {
      // ignore offline/deleted fetch errors
    }
  }

  async function getLocalOrRemoteFileUrl(msg) {
    if (!msg.file_id) return null;
    if (state.blobUrlCache[msg.file_id]) return state.blobUrlCache[msg.file_id];
    const cached = await LocalVault.getFile(msg.file_id);
    if (cached && cached.blob) {
      state.blobUrlCache[msg.file_id] = URL.createObjectURL(cached.blob);
      return state.blobUrlCache[msg.file_id];
    }
    return msg.file_url || null;
  }

  async function downloadFileFromLocalOrServer(fileId, fileName, fallbackUrl) {
    const cached = await LocalVault.getFile(fileId);
    let url = null;
    let revoke = false;
    if (cached && cached.blob) {
      url = URL.createObjectURL(cached.blob);
      revoke = true;
    } else if (fallbackUrl) {
      url = fallbackUrl;
    }
    if (!url) {
      showToast("Fayl topilmadi");
      return;
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "ghostgram_file";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function updateVaultBadge() {
    try {
      const deleted = await LocalVault.getDeletedMessages();
      const badge = $("vault-badge");
      if (deleted.length > 0) {
        badge.textContent = String(deleted.length);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch (_) {}
  }

  // =========================================================
  // 4. Theme & Auth UI
  // =========================================================
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    $("btn-theme").textContent = state.theme === "dark" ? "☀️" : "🌙";
    localStorage.setItem("gg_theme", state.theme);
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    $("tab-login").classList.toggle("active", mode === "login");
    $("tab-register").classList.toggle("active", mode === "register");
    $("field-display-name").style.display = mode === "register" ? "block" : "none";
    $("auth-submit").textContent = mode === "register" ? "Ro'yxatdan o'tish" : "Kirish";
    $("auth-error").hidden = true;
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    const username = $("input-username").value.trim();
    const password = $("input-password").value;
    const displayName = $("input-display-name").value.trim();
    const errEl = $("auth-error");
    errEl.hidden = true;

    try {
      let res;
      if (state.authMode === "register") {
        if (!displayName) throw new Error("Ismingizni kiriting");
        res = await api("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ username, display_name: displayName, password }),
        });
      } else {
        res = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
      }
      state.token = res.token;
      state.user = res.user;
      localStorage.setItem("gg_token", state.token);
      await enterApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  async function enterApp() {
    $("auth-screen").hidden = true;
    $("app-shell").hidden = false;
    renderSelfProfile();
    await LocalVault.init();
    await updateVaultBadge();
    await loadChats();
    connectWebSocket();
  }

  function renderSelfProfile() {
    if (!state.user) return;
    $("self-name").textContent = state.user.display_name;
    const av = $("self-avatar");
    av.textContent = initials(state.user.display_name);
    av.style.background = state.user.avatar_color;

    const ghostOn = Boolean(state.user.ghost?.enabled);
    $("btn-ghost-toggle").classList.toggle("active", ghostOn);
    $("ghost-pill-label").textContent = ghostOn ? "Ghost ON" : "Ghost";
    $("chat-ghost-indicator").hidden = !ghostOn;
  }

  // =========================================================
  // 5. WebSocket Connection & Real-Time Handlers
  // =========================================================
  function connectWebSocket() {
    if (!state.token) return;
    if (state.ws) {
      try { state.ws.close(); } catch (_) {}
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;

    ws.onopen = () => {
      const st = $("ws-status");
      st.textContent = state.user?.ghost?.enabled && state.user?.ghost?.hide_online ? "Ghost (yashirin)" : "Onlayn";
      st.classList.add("online");
      clearInterval(state.pingTimer);
      state.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 25000);
    };

    ws.onmessage = async (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (_) { return; }
      await handleWsEvent(data);
    };

    ws.onclose = () => {
      const st = $("ws-status");
      st.textContent = "Qayta ulanmoqda...";
      st.classList.remove("online");
      clearInterval(state.pingTimer);
      if (state.token) {
        clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = setTimeout(connectWebSocket, 2500);
      }
    };
  }

  async function handleWsEvent(ev) {
    if (ev.type === "new_message") {
      const msg = ev.message;
      const cid = msg.chat_id;

      // Save to IndexedDB Anti-Delete Vault immediately
      if (state.antiDelete) {
        const chatObj = state.chats.find((c) => c.id === cid);
        await LocalVault.putMessage({ ...msg, chat_title: chatObj?.title || `Chat #${cid}` });
        if (msg.file_id) {
          cacheFileLocally(msg);
        }
      }

      if (!state.messagesByChat[cid]) state.messagesByChat[cid] = [];
      if (!state.messagesByChat[cid].some((m) => m.id === msg.id)) {
        state.messagesByChat[cid].push(msg);
      }

      // Clear sender's live draft
      if (state.liveDrafts[cid] && state.liveDrafts[cid][msg.sender_id]) {
        delete state.liveDrafts[cid][msg.sender_id];
      }

      if (state.activeChatId === cid) {
        await renderMessages();
        renderLiveDrafts();
        if (msg.sender_id !== state.user.id) {
          sendMarkRead(cid);
        }
      }
      await loadChats();
    } else if (ev.type === "message_edited") {
      const msg = ev.message;
      const list = state.messagesByChat[msg.chat_id] || [];
      const idx = list.findIndex((m) => m.id === msg.id);
      if (idx !== -1) list[idx] = msg;
      if (state.antiDelete) {
        await LocalVault.putMessage(msg);
      }
      if (state.activeChatId === msg.chat_id) {
        await renderMessages();
      }
      await loadChats();
    } else if (ev.type === "message_deleted") {
      const { chat_id, message_id, deleted_at } = ev;
      if (state.antiDelete) {
        const preserved = await LocalVault.markDeleted(message_id, deleted_at);
        const list = state.messagesByChat[chat_id] || [];
        const idx = list.findIndex((m) => m.id === message_id);
        if (idx !== -1) {
          list[idx] = { ...list[idx], locally_deleted: true, deleted_at };
        } else if (preserved) {
          list.push(preserved);
        }
        await updateVaultBadge();
        showToast("🗑 Xabar o'chirildi, lekin lokal xotirada saqlab qolindi!");
      } else {
        const list = state.messagesByChat[chat_id] || [];
        state.messagesByChat[chat_id] = list.filter((m) => m.id !== message_id);
      }
      if (state.activeChatId === chat_id) {
        await renderMessages();
      }
      await loadChats();
    } else if (ev.type === "live_draft") {
      const { chat_id, user_id, display_name, text, ts } = ev;
      if (!state.liveDrafts[chat_id]) state.liveDrafts[chat_id] = {};
      if (!text) {
        delete state.liveDrafts[chat_id][user_id];
      } else {
        state.liveDrafts[chat_id][user_id] = {
          display_name: display_name || "Foydalanuvchi",
          text,
          ts: ts || Date.now(),
        };
      }
      if (state.activeChatId === chat_id) {
        renderLiveDrafts();
        updateActiveChatSubtitle();
      }
      renderChatList();
    } else if (ev.type === "messages_read") {
      const { chat_id, reader_id, message_ids } = ev;
      const list = state.messagesByChat[chat_id] || [];
      for (const m of list) {
        if (message_ids.includes(m.id)) {
          m.read_by = Array.from(new Set([...(m.read_by || []), reader_id]));
        }
      }
      if (state.activeChatId === chat_id) {
        await renderMessages();
      }
    } else if (ev.type === "presence_update") {
      for (const c of state.chats) {
        if (!c.is_group && c.peer_id === ev.user_id) {
          c.peer_online = ev.online;
          c.peer_last_seen = ev.last_seen;
        }
      }
      renderChatList();
      updateActiveChatSubtitle();
    } else if (ev.type === "chat_updated") {
      await loadChats();
    }
  }

  function sendMarkRead(chatId) {
    if (state.user?.ghost?.enabled && state.user?.ghost?.hide_read_receipts) {
      return; // Ghost Mode blocks read receipts
    }
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "mark_read", chat_id: chatId }));
    } else {
      api(`/api/chats/${chatId}/read`, { method: "POST" }).catch(() => {});
    }
  }

  // Cleanup stale live drafts after 15s inactivity
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const cid of Object.keys(state.liveDrafts)) {
      for (const uid of Object.keys(state.liveDrafts[cid])) {
        if (now - state.liveDrafts[cid][uid].ts > 15000) {
          delete state.liveDrafts[cid][uid];
          changed = true;
        }
      }
    }
    if (changed) {
      renderLiveDrafts();
      renderChatList();
      updateActiveChatSubtitle();
    }
  }, 4000);

  // =========================================================
  // 6. Chats & Messages
  // =========================================================
  async function loadChats() {
    try {
      const res = await api("/api/chats");
      state.chats = res.chats || [];
      renderChatList();
      updateActiveChatSubtitle();
    } catch (_) {}
  }

  function renderChatList() {
    const container = $("chat-list");
    const filter = $("global-search").value.trim().toLowerCase();
    const list = state.chats.filter((c) => !filter || c.title.toLowerCase().includes(filter));

    if (!list.length) {
      container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">Chatlar yo'q. Yuqoridan @username qidiring.</div>`;
      return;
    }

    container.innerHTML = list
      .map((c) => {
        const drafts = state.liveDrafts[c.id] ? Object.values(state.liveDrafts[c.id]) : [];
        let previewHtml = "";
        if (drafts.length > 0) {
          const d = drafts[0];
          previewHtml = `<div class="chat-preview live-typing-preview">⚡ ${escapeHtml(d.display_name)}: "${escapeHtml(d.text.slice(0, 32))}"</div>`;
        } else if (c.last_message) {
          const lm = c.last_message;
          const prefix = c.is_group ? `${lm.sender_name}: ` : lm.sender_id === state.user.id ? "Siz: " : "";
          const body = lm.content || (lm.file_name ? `📎 ${lm.file_name}` : "");
          previewHtml = `<div class="chat-preview">${escapeHtml(prefix + body)}</div>`;
        } else {
          previewHtml = `<div class="chat-preview">Xabarlar yo'q</div>`;
        }

        const timeStr = c.last_message ? formatTime(c.last_message.created_at) : "";
        const unread = c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count}</span>` : "";
        const onlineDot = c.peer_online ? `<span class="online-dot"></span>` : "";

        return `
          <div class="chat-item ${c.id === state.activeChatId ? "active" : ""}" data-chat-id="${c.id}">
            <div class="avatar" style="background:${c.avatar_color}">
              ${escapeHtml(initials(c.title))}
              ${onlineDot}
            </div>
            <div class="chat-item-body">
              <div class="chat-item-top">
                <div class="chat-item-title">${c.is_group ? "👥 " : ""}${escapeHtml(c.title)}</div>
                <div class="chat-time">${timeStr}</div>
              </div>
              <div class="chat-item-bottom">
                ${previewHtml}
                ${unread}
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    container.querySelectorAll(".chat-item").forEach((el) => {
      el.addEventListener("click", () => openChat(Number(el.dataset.chatId)));
    });
  }

  async function openChat(chatId) {
    state.activeChatId = chatId;
    state.replyTo = null;
    state.editingMsg = null;
    updateComposerContext();
    $("empty-state").hidden = true;
    $("active-chat").hidden = false;
    $("app-shell").classList.add("mobile-chat-open");

    const chat = state.chats.find((c) => c.id === chatId);
    if (chat) {
      $("chat-title").textContent = chat.title;
      const av = $("chat-avatar");
      av.textContent = initials(chat.title);
      av.style.background = chat.avatar_color;
    }
    updateActiveChatSubtitle();
    renderChatList();

    // Load server messages + merge locally preserved deleted messages from IndexedDB
    const res = await api(`/api/chats/${chatId}/messages`);
    const serverMsgs = res.messages || [];

    if (state.antiDelete) {
      for (const m of serverMsgs) {
        await LocalVault.putMessage({ ...m, chat_title: chat?.title || `Chat #${chatId}` });
        if (m.file_id) cacheFileLocally(m);
      }
      const localMsgs = await LocalVault.getChatMessages(chatId);
      const serverIds = new Set(serverMsgs.map((m) => m.id));
      const merged = [...serverMsgs];
      for (const lm of localMsgs) {
        if (!serverIds.has(lm.id)) {
          merged.push({ ...lm, locally_deleted: true });
        }
      }
      merged.sort((a, b) => a.created_at - b.created_at || a.id - b.id);
      state.messagesByChat[chatId] = merged;
    } else {
      state.messagesByChat[chatId] = serverMsgs;
    }

    await renderMessages();
    renderLiveDrafts();
    sendMarkRead(chatId);
    scrollToBottom();
    $("message-input").focus();
  }

  function updateActiveChatSubtitle() {
    if (!state.activeChatId) return;
    const chat = state.chats.find((c) => c.id === state.activeChatId);
    if (!chat) return;
    const sub = $("chat-subtitle");
    const drafts = state.liveDrafts[chat.id] ? Object.values(state.liveDrafts[chat.id]) : [];
    if (drafts.length > 0) {
      sub.textContent = `⚡ ${drafts[0].display_name} jonli yozmoqda...`;
      sub.classList.add("online");
      return;
    }
    if (chat.is_group) {
      sub.textContent = `${chat.member_count} a'zo`;
      sub.classList.remove("online");
    } else if (chat.peer_online) {
      sub.textContent = "onlayn";
      sub.classList.add("online");
    } else if (chat.peer_last_seen) {
      sub.textContent = `oxirgi faollik ${formatTime(chat.peer_last_seen)}`;
      sub.classList.remove("online");
    } else {
      sub.textContent = "yaqinda bo'lgan";
      sub.classList.remove("online");
    }
  }

  async function renderMessages() {
    const cid = state.activeChatId;
    if (!cid) return;
    const chat = state.chats.find((c) => c.id === cid);
    const msgs = (state.messagesByChat[cid] || []).filter((m) => {
      if (!state.inChatSearch) return true;
      const q = state.inChatSearch.toLowerCase();
      return (m.content || "").toLowerCase().includes(q) || (m.file_name || "").toLowerCase().includes(q);
    });

    const msgMap = new Map(msgs.map((m) => [m.id, m]));
    const htmlParts = [];

    for (const m of msgs) {
      const isOut = m.sender_id === state.user.id;
      const isDel = Boolean(m.locally_deleted || m.is_deleted);
      const replyTarget = m.reply_to_id ? msgMap.get(m.reply_to_id) : null;

      let mediaHtml = "";
      if (m.file_id) {
        const url = await getLocalOrRemoteFileUrl(m);
        const mime = m.file_mime || "";
        if (url && mime.startsWith("image/")) {
          mediaHtml = `
            <div class="msg-media">
              <img src="${url}" alt="${escapeHtml(m.file_name || "rasm")}" />
              <div style="margin-top:4px;">
                <button class="file-download-btn" data-dl-id="${m.file_id}" data-dl-name="${escapeHtml(m.file_name || "rasm")}" data-dl-url="${escapeHtml(m.file_url || "")}">⬇ Saqlash</button>
              </div>
            </div>`;
        } else if (url && mime.startsWith("video/")) {
          mediaHtml = `<div class="msg-media"><video controls src="${url}"></video></div>`;
        } else if (url && mime.startsWith("audio/")) {
          mediaHtml = `<div class="msg-media"><audio controls src="${url}"></audio></div>`;
        } else {
          mediaHtml = `
            <div class="file-card">
              <span>📄</span>
              <div class="file-card-meta">
                <div class="file-card-name">${escapeHtml(m.file_name || "Fayl")}</div>
                <div class="file-card-size">${formatBytes(m.file_size)}${isDel ? " • Lokal keshdan" : ""}</div>
              </div>
              <button class="file-download-btn" data-dl-id="${m.file_id}" data-dl-name="${escapeHtml(m.file_name || "file")}" data-dl-url="${escapeHtml(m.file_url || "")}">⬇</button>
            </div>`;
        }
      }

      const readTick = isOut
        ? (m.read_by || []).some((uid) => uid !== state.user.id)
          ? "✓✓"
          : "✓"
        : "";

      htmlParts.push(`
        <div class="msg-row ${isOut ? "out" : "in"}" data-msg-id="${m.id}">
          <div class="msg-bubble ${isDel ? "deleted-preserved" : ""}">
            ${isDel ? `<div class="deleted-badge">🗑 O'chirilgan • Lokal xotirada saqlangan</div>` : ""}
            ${chat?.is_group && !isOut ? `<div class="msg-sender" style="color:${m.sender_color || "#2aabee"}">${escapeHtml(m.sender_name)}</div>` : ""}
            ${replyTarget ? `<div class="msg-reply-ref">↩ ${escapeHtml(replyTarget.sender_name)}: ${escapeHtml((replyTarget.content || replyTarget.file_name || "").slice(0, 60))}</div>` : ""}
            ${mediaHtml}
            ${m.content ? `<div class="msg-text">${escapeHtml(m.content)}</div>` : ""}
            <div class="msg-meta">
              ${m.edited_at ? `<span>tahrirlandi</span>` : ""}
              <span>${formatTime(m.created_at)}</span>
              ${readTick ? `<span>${readTick}</span>` : ""}
            </div>
          </div>
          ${!isDel ? `
            <div class="msg-actions">
              <button class="msg-action-btn" data-reply="${m.id}">Javob</button>
              ${isOut && m.content ? `<button class="msg-action-btn" data-edit="${m.id}">Tahrirlash</button>` : ""}
              ${isOut ? `<button class="msg-action-btn" data-delete="${m.id}">O'chirish</button>` : ""}
            </div>` : ""}
        </div>
      `);
    }

    const listEl = $("messages-list");
    listEl.innerHTML = htmlParts.join("");

    listEl.querySelectorAll("[data-dl-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        downloadFileFromLocalOrServer(btn.dataset.dlId, btn.dataset.dlName, btn.dataset.dlUrl);
      });
    });

    listEl.querySelectorAll("[data-reply]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const msg = msgMap.get(Number(btn.dataset.reply));
        if (msg) {
          state.replyTo = msg;
          state.editingMsg = null;
          updateComposerContext();
          $("message-input").focus();
        }
      });
    });

    listEl.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const msg = msgMap.get(Number(btn.dataset.edit));
        if (msg) {
          state.editingMsg = msg;
          state.replyTo = null;
          $("message-input").value = msg.content;
          updateComposerContext();
          $("message-input").focus();
        }
      });
    });

    listEl.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = Number(btn.dataset.delete);
        try {
          await api(`/api/messages/${id}`, { method: "DELETE" });
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  }

  function renderLiveDrafts() {
    const container = $("live-drafts-container");
    const cid = state.activeChatId;
    if (!cid || !state.liveDrafts[cid]) {
      container.innerHTML = "";
      return;
    }
    const entries = Object.values(state.liveDrafts[cid]).filter((d) => d.text);
    if (!entries.length) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML = entries
      .map(
        (d) => `
      <div class="live-draft-bubble">
        <div class="live-draft-header">
          <span class="live-dot"></span>
          <span>⚡ ${escapeHtml(d.display_name)} hozir yozmoqda (hali yuborilmadi)</span>
        </div>
        <div class="live-draft-text">${escapeHtml(d.text)}<span class="typing-cursor"></span></div>
      </div>`
      )
      .join("");
    scrollToBottom();
  }

  function scrollToBottom() {
    const el = $("messages-container");
    el.scrollTop = el.scrollHeight;
  }

  // =========================================================
  // 7. Composer & Live Typing Stream Sender
  // =========================================================
  function emitLiveDraft(text) {
    if (!state.activeChatId || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    if (state.editingMsg) return;
    const now = Date.now();
    const sendNow = () => {
      state.lastDraftSentAt = Date.now();
      if (state.ws && state.ws.readyState === WebSocket.OPEN && state.activeChatId) {
        state.ws.send(
          JSON.stringify({
            type: "live_draft",
            chat_id: state.activeChatId,
            text,
          })
        );
      }
    };
    if (!text || now - state.lastDraftSentAt >= 75) {
      clearTimeout(state.draftThrottleTimer);
      sendNow();
    } else {
      clearTimeout(state.draftThrottleTimer);
      state.draftThrottleTimer = setTimeout(sendNow, 75);
    }
  }

  function updateComposerContext() {
    const bar = $("composer-context");
    if (state.editingMsg) {
      bar.hidden = false;
      $("context-bar-title").textContent = "Xabarni tahrirlash";
      $("context-bar-text").textContent = state.editingMsg.content;
    } else if (state.replyTo) {
      bar.hidden = false;
      $("context-bar-title").textContent = `${state.replyTo.sender_name} xabariga javob`;
      $("context-bar-text").textContent = state.replyTo.content || state.replyTo.file_name || "Fayl";
    } else {
      bar.hidden = true;
    }
  }

  async function sendMessage() {
    if (!state.activeChatId) return;
    const input = $("message-input");
    const content = input.value.trim();

    if (state.editingMsg) {
      if (!content) return;
      try {
        await api(`/api/messages/${state.editingMsg.id}`, {
          method: "PUT",
          body: JSON.stringify({ content }),
        });
        state.editingMsg = null;
        input.value = "";
        updateComposerContext();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (!content && !state.pendingFile) return;

    let fileMeta = null;
    if (state.pendingFile) {
      const fd = new FormData();
      fd.append("file", state.pendingFile);
      try {
        fileMeta = await api("/api/files/upload", { method: "POST", body: fd });
        if (state.antiDelete) {
          await LocalVault.putFile(fileMeta.file_id, fileMeta.file_name, fileMeta.file_mime, state.pendingFile);
        }
      } catch (err) {
        showToast(err.message);
        return;
      }
    }

    try {
      await api(`/api/chats/${state.activeChatId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content,
          file_id: fileMeta?.file_id || null,
          file_name: fileMeta?.file_name || null,
          file_mime: fileMeta?.file_mime || null,
          file_size: fileMeta?.file_size || null,
          reply_to_id: state.replyTo?.id || null,
        }),
      });
      input.value = "";
      input.style.height = "auto";
      state.replyTo = null;
      state.pendingFile = null;
      $("attachment-bar").hidden = true;
      updateComposerContext();
      emitLiveDraft("");
      scrollToBottom();
    } catch (err) {
      showToast(err.message);
    }
  }

  // =========================================================
  // 8. Global Search, Ghost Modal, Vault Modal, New Group
  // =========================================================
  let searchTimer = null;
  function handleGlobalSearch() {
    renderChatList();
    const q = $("global-search").value.trim();
    const box = $("search-results");
    if (q.length < 2) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        const res = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
        const users = res.users || [];
        if (!users.length) {
          box.hidden = true;
          return;
        }
        box.hidden = false;
        box.innerHTML =
          `<div class="search-section-label">Foydalanuvchilar</div>` +
          users
            .map(
              (u) => `
          <div class="chat-item" data-user-id="${u.id}">
            <div class="avatar sm" style="background:${u.avatar_color}">${escapeHtml(initials(u.display_name))}</div>
            <div class="chat-item-body">
              <div class="chat-item-title">${escapeHtml(u.display_name)}</div>
              <div class="chat-preview">@${escapeHtml(u.username)}</div>
            </div>
          </div>`
            )
            .join("");

        box.querySelectorAll("[data-user-id]").forEach((el) => {
          el.addEventListener("click", async () => {
            const uid = Number(el.dataset.userId);
            const r = await api("/api/chats/direct", {
              method: "POST",
              body: JSON.stringify({ target_user_id: uid }),
            });
            $("global-search").value = "";
            box.hidden = true;
            await loadChats();
            await openChat(r.chat_id);
          });
        });
      } catch (_) {}
    }, 220);
  }

  function openGhostModal() {
    const g = state.user?.ghost || {};
    $("chk-ghost-enabled").checked = Boolean(g.enabled);
    $("chk-hide-read").checked = g.hide_read_receipts !== false;
    $("chk-hide-online").checked = g.hide_online !== false;
    $("chk-hide-typing").checked = Boolean(g.hide_typing);
    $("chk-live-share").checked = g.live_typing_share !== false;
    $("chk-anti-delete").checked = state.antiDelete;
    $("modal-ghost").hidden = false;
  }

  async function saveGhostSettings() {
    const payload = {
      enabled: $("chk-ghost-enabled").checked,
      hide_read_receipts: $("chk-hide-read").checked,
      hide_online: $("chk-hide-online").checked,
      hide_typing: $("chk-hide-typing").checked,
      live_typing_share: $("chk-live-share").checked,
    };
    state.antiDelete = $("chk-anti-delete").checked;
    localStorage.setItem("gg_anti_delete", state.antiDelete ? "1" : "0");

    try {
      const res = await api("/api/settings/ghost", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      state.user = res.user;
      renderSelfProfile();
      $("modal-ghost").hidden = true;
      showToast(payload.enabled ? "👻 Ghost rejimi yoqildi" : "Sozlamalar saqlandi");
    } catch (err) {
      showToast(err.message);
    }
  }

  async function openVaultModal() {
    $("modal-vault").hidden = false;
    const deleted = await LocalVault.getDeletedMessages();
    const files = await LocalVault.getAllFiles();
    const totalBytes = files.reduce((acc, f) => acc + (f.file_size || 0), 0);

    $("vault-stats").textContent = `O'chirilgan xabarlar: ${deleted.length} ta • Keshlangan fayllar: ${files.length} ta (${formatBytes(totalBytes)})`;

    const listEl = $("vault-list");
    if (!deleted.length) {
      listEl.innerHTML = `<div class="muted" style="padding:12px 0;">Hozircha o'chirilgan xabar yoki fayllar yo'q. Kimdir xabarini o'chirishi bilan u avtomatik shu yerda paydo bo'ladi.</div>`;
      return;
    }

    listEl.innerHTML = deleted
      .map(
        (m) => `
      <div class="vault-item">
        <div class="vault-item-head">
          <strong>${escapeHtml(m.sender_name || "Foydalanuvchi")} (${escapeHtml(m.chat_title || "Chat")})</strong>
          <span>O'chirilgan: ${formatTime(m.deleted_at || m.created_at)}</span>
        </div>
        ${m.content ? `<div class="msg-text">${escapeHtml(m.content)}</div>` : ""}
        ${
          m.file_id
            ? `<div class="file-card" style="margin-top:8px;">
                 <span>📎</span>
                 <div class="file-card-meta">
                   <div class="file-card-name">${escapeHtml(m.file_name || "Fayl")}</div>
                   <div class="file-card-size">${formatBytes(m.file_size)} • Lokal xotirada</div>
                 </div>
                 <button class="file-download-btn" data-vault-dl="${m.file_id}" data-vault-name="${escapeHtml(m.file_name || "file")}">⬇ Yuklab olish</button>
               </div>`
            : ""
        }
      </div>`
      )
      .join("");

    listEl.querySelectorAll("[data-vault-dl]").forEach((btn) => {
      btn.addEventListener("click", () => {
        downloadFileFromLocalOrServer(btn.dataset.vaultDl, btn.dataset.vaultName, null);
      });
    });
  }

  // Group Modal
  async function searchGroupUsers() {
    const q = $("group-user-search").value.trim();
    const res = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
    const box = $("group-user-results");
    box.innerHTML = (res.users || [])
      .map(
        (u) => `
      <div class="mini-user-item" data-add-uid="${u.id}" data-add-name="${escapeHtml(u.display_name)}">
        <span>${escapeHtml(u.display_name)} <small class="muted">@${escapeHtml(u.username)}</small></span>
        <span>${state.groupSelectedUsers.has(u.id) ? "✓" : "+"}</span>
      </div>`
      )
      .join("");

    box.querySelectorAll("[data-add-uid]").forEach((el) => {
      el.addEventListener("click", () => {
        const uid = Number(el.dataset.addUid);
        if (state.groupSelectedUsers.has(uid)) {
          state.groupSelectedUsers.delete(uid);
        } else {
          state.groupSelectedUsers.set(uid, el.dataset.addName);
        }
        renderGroupChips();
        searchGroupUsers();
      });
    });
  }

  function renderGroupChips() {
    $("group-selected-chips").innerHTML = Array.from(state.groupSelectedUsers.entries())
      .map(([uid, name]) => `<span class="chip">${escapeHtml(name)} <button data-rm-uid="${uid}" style="border:none;background:none;color:#fff;cursor:pointer;">✕</button></span>`)
      .join("");
    $("group-selected-chips")
      .querySelectorAll("[data-rm-uid]")
      .forEach((b) =>
        b.addEventListener("click", () => {
          state.groupSelectedUsers.delete(Number(b.dataset.rmUid));
          renderGroupChips();
          searchGroupUsers();
        })
      );
  }

  async function createGroupChat() {
    const title = $("group-title-input").value.trim();
    if (!title) {
      showToast("Guruh nomini kiriting");
      return;
    }
    try {
      const r = await api("/api/chats/group", {
        method: "POST",
        body: JSON.stringify({
          title,
          member_ids: Array.from(state.groupSelectedUsers.keys()),
        }),
      });
      $("modal-group").hidden = true;
      $("group-title-input").value = "";
      state.groupSelectedUsers.clear();
      renderGroupChips();
      await loadChats();
      await openChat(r.chat_id);
    } catch (err) {
      showToast(err.message);
    }
  }

  // =========================================================
  // 9. Event Bindings & Bootstrap
  // =========================================================
  function bindEvents() {
    $("tab-login").addEventListener("click", () => setAuthMode("login"));
    $("tab-register").addEventListener("click", () => setAuthMode("register"));
    $("auth-form").addEventListener("submit", handleAuthSubmit);

    $("btn-theme").addEventListener("click", () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme();
    });

    $("btn-logout").addEventListener("click", () => {
      state.token = "";
      localStorage.removeItem("gg_token");
      if (state.ws) state.ws.close();
      location.reload();
    });

    $("global-search").addEventListener("input", handleGlobalSearch);
    $("btn-ghost-toggle").addEventListener("click", openGhostModal);
    $("btn-save-ghost").addEventListener("click", saveGhostSettings);
    $("btn-vault").addEventListener("click", openVaultModal);
    $("btn-clear-vault").addEventListener("click", async () => {
      await LocalVault.clearAll();
      await updateVaultBadge();
      await openVaultModal();
      showToast("Lokal kesh tozalandi");
    });

    $("btn-new-group").addEventListener("click", () => {
      $("modal-group").hidden = false;
      searchGroupUsers();
    });
    $("group-user-search").addEventListener("input", searchGroupUsers);
    $("btn-create-group").addEventListener("click", createGroupChat);

    document.querySelectorAll(".modal-close").forEach((btn) => {
      btn.addEventListener("click", () => {
        $(btn.dataset.close).hidden = true;
      });
    });

    $("btn-back-mobile").addEventListener("click", () => {
      $("app-shell").classList.remove("mobile-chat-open");
    });

    $("btn-chat-search").addEventListener("click", () => {
      const bar = $("in-chat-search-bar");
      bar.hidden = !bar.hidden;
      if (!bar.hidden) $("in-chat-search-input").focus();
    });
    $("btn-close-chat-search").addEventListener("click", () => {
      $("in-chat-search-bar").hidden = true;
      $("in-chat-search-input").value = "";
      state.inChatSearch = "";
      renderMessages();
    });
    $("in-chat-search-input").addEventListener("input", (e) => {
      state.inChatSearch = e.target.value.trim();
      renderMessages();
    });

    $("btn-cancel-context").addEventListener("click", () => {
      state.replyTo = null;
      state.editingMsg = null;
      $("message-input").value = "";
      updateComposerContext();
    });

    $("btn-attach").addEventListener("click", () => $("file-input").click());
    $("file-input").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      state.pendingFile = f;
      $("attachment-name").textContent = `📎 ${f.name}`;
      $("attachment-size").textContent = formatBytes(f.size);
      $("attachment-bar").hidden = false;
      e.target.value = "";
    });
    $("btn-cancel-attachment").addEventListener("click", () => {
      state.pendingFile = null;
      $("attachment-bar").hidden = true;
    });

    const msgInput = $("message-input");
    msgInput.addEventListener("input", () => {
      msgInput.style.height = "auto";
      msgInput.style.height = Math.min(msgInput.scrollHeight, 130) + "px";
      emitLiveDraft(msgInput.value);
    });
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    $("btn-send").addEventListener("click", sendMessage);
  }

  async function init() {
    applyTheme();
    bindEvents();
    if (state.token) {
      try {
        const res = await api("/api/auth/me");
        state.user = res.user;
        await enterApp();
        return;
      } catch (_) {
        localStorage.removeItem("gg_token");
        state.token = "";
      }
    }
    $("auth-screen").hidden = false;
  }

  init();
})();

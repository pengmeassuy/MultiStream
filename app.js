// =====================================================================
//  MultiView: watch many YouTube streams at once
//  Sections: 1 Constants · 2 Helpers · 3 State · 4 Tabs & chat
//            5 Layout · 6 Tiles · 7 Menu · 8 Render · 9 Add dialog
//            10 Events · 11 Start
// =====================================================================


// ===== 1. CONSTANTS ==================================================
const TICK_MS = 500;            // how often the seek bars update
const BADGE_MS = 2000;          // how often the LIVE badges update
const LIVE_TOLERANCE_S = 12;    // within this many seconds of the edge = "live"
const SNAP_MS = 4000;           // hold the seek bar at the end after "go live"
const SKIP_S = 10;              // arrow keys skip this many seconds
const FETCH_TIMEOUT_MS = 5000;  // give up on slow lookups
const INFO_MS = 300000;         // refresh pictures + LIVE badges every 5 minutes

// API_KEY comes from config.js (loaded before this file). Without it the app
// still works, with letters instead of pictures.
const KEY = typeof API_KEY === "undefined" ? "" : API_KEY;


// ===== 2. HELPERS ====================================================
const $ = (id) => document.getElementById(id);

function make(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function mkBtn(text, label, className = "") {
    const b = make("button", className, text);
    b.setAttribute("aria-label", label);
    return b;
}

function mkSlider(max, value, className, label) {
    const input = make("input", className);
    input.type = "range";
    input.min = 0;
    input.max = max;
    input.value = value;
    input.setAttribute("aria-label", label);
    return input;
}

async function fetchJson(url, ms = FETCH_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function getName(id, fallback) {
    try {
        const data = await fetchJson(
            `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`
        );
        return data.author_name || fallback;
    } catch (e) {
        return fallback;
    }
}

// takes up to 50 video IDs, returns { videoId: { channel, avatar, live } }
async function getInfo(ids) {
    if (!KEY || !ids.length) return {};
    const base = "https://www.googleapis.com/youtube/v3";
    try {
        const v = await fetchJson(
            `${base}/videos?part=snippet,liveStreamingDetails&id=${ids.join(",")}&key=${KEY}`
        );
        const items = v.items || [];
        if (!items.length) return {};

        const chIds = [...new Set(items.map(i => i.snippet.channelId))];
        const c = await fetchJson(
            `${base}/channels?part=snippet&id=${chIds.join(",")}&key=${KEY}`
        );
        const pics = {};
        (c.items || []).forEach(ch => { pics[ch.id] = ch.snippet.thumbnails.default.url; });

        const out = {};
        items.forEach(i => {
            const d = i.liveStreamingDetails;
            out[i.id] = {
                channel: i.snippet.channelTitle,
                avatar: pics[i.snippet.channelId],
                live: !!(d && d.actualStartTime && !d.actualEndTime),   // started, not ended
            };
        });
        return out;
    } catch (e) {
        console.error("getInfo failed:", e);
        return {};
    }
}

function parseId(text) {
    text = text.trim();
    if (/^[\w-]{11}$/.test(text)) return text;          // already an ID

    try {
        const url = new URL(text);
        if (url.hostname.includes("youtu.be")) return url.pathname.slice(1, 12);
        if (url.searchParams.get("v")) return url.searchParams.get("v").slice(0, 11);
        const m = url.pathname.match(/\/(live|shorts)\/([\w-]{11})/);
        if (m) return m[2];
    } catch (e) {}

    return null;                                         // not a valid link
}

function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch (e) { return fallback; }
}

function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}


// ===== 3. STATE ======================================================
let streams = readJson("mv_streams", []);      // on the wall
let library = readJson("mv_library", []);      // saved in the left menu
let layout = localStorage.getItem("mv_layout") || "grid";
let active = null;                             // id of the stream shown in chat / focus
let hovered = null;                            // id under the mouse (for arrow keys)
let emptyEl = null;

const tiles = new Map();                       // stream id -> { el, nm, player, ... }
const liveIds = {};                            // video id -> true if currently live

const save = () => writeJson("mv_streams", streams);
const saveLib = () => writeJson("mv_library", library);

// streams already on the wall also belong in the menu
streams.forEach(s => {
    if (!library.some(l => l.id === s.id)) library.push({ id: s.id, name: s.name });
});
saveLib();

const grid = $("grid");
const list = $("list");


// ===== 4. TABS & CHAT ================================================
function markActive() {
    document.querySelectorAll(".tile").forEach(t =>
        t.classList.toggle("active", t.dataset.id === active)
    );
}

function setActive(id) {
    active = id;
    renderTabs();      // tabs and chat
    markActive();      // moves the big tile in focus view
}

function renderTabs() {
    const tabs = $("tabs");
    tabs.innerHTML = "";

    // nothing active yet (or it was removed): default to the first stream
    if (!streams.some(s => s.id === active)) {
        active = streams.length ? streams[0].id : null;
    }

    streams.forEach(s => {
        const btn = make("button", s.id === active ? "on" : "", s.name);
        btn.onclick = () => setActive(s.id);
        tabs.appendChild(btn);
    });

    const chat = $("chat");
    const src = active
        ? `https://www.youtube.com/live_chat?v=${active}&embed_domain=${location.hostname}&dark_theme=1`
        : "about:blank";
    if (chat.dataset.src !== src) {            // only reload the chat when it changes
        chat.dataset.src = src;
        chat.src = src;
    }
    markActive();
}


// ===== 5. LAYOUT =====================================================
function applyLayout() {
    if (!streams.length) return;
    const focus = layout === "focus" && streams.length > 1;

    grid.classList.toggle("focus", focus);
    if (focus) {
        grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(240px, 1fr))";
    } else {
        const cols = Math.ceil(Math.sqrt(streams.length));
        grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    }
    $("layout").textContent = layout === "focus" ? "Grid view" : "Focus view";
}


// ===== 6. TILES (one video with its custom controls) =================
function removeStream(id) {
    streams = streams.filter(s => s.id !== id);
    library = library.filter(l => l.id !== id);        // also remove from the menu
    save();
    saveLib();
    render();
}

function makeTile(s) {
    // ---------- DOM ----------
    const el = make("div", "tile");
    el.dataset.id = s.id;

    const nm = make("span", "", s.name);
    const label = make("button", "label");
    label.append(make("span", "live"), nm);

    const removeBtn = mkBtn("✕", "Remove stream", "remove");
    removeBtn.onclick = () => removeStream(s.id);

    const bar = make("div", "bar");
    bar.append(label, removeBtn);
    bar.onclick = (e) => {
        if (e.target.closest(".remove")) return;       // removing is not focusing
        setActive(s.id);
    };

    const seek = mkSlider(1000, 0, "seek", "Seek");
    const vol = mkSlider(100, 50, "vol", "Volume");
    const playBtn = mkBtn("❚❚", "Pause");
    const muteBtn = mkBtn("🔇", "Unmute");
    const liveBtn = mkBtn("● LIVE", "Go to live", "golive");
    const fsBtn = mkBtn("⛶", "Fullscreen");
    liveBtn.hidden = true;                             // only shown for live streams

    const row = make("div", "row");
    row.append(playBtn, muteBtn, vol, liveBtn, fsBtn);
    const ctrl = make("div", "ctrl");
    ctrl.append(seek, row);

    const holder = make("div");                        // YouTube swaps this for the iframe
    const shield = make("div", "shield");              // catches clicks on the video
    const stage = make("div", "stage");
    stage.append(holder, shield, ctrl);

    el.append(bar, stage);
    grid.appendChild(el);

    // ---------- player ----------
    let userPaused = false;                            // true when YOU paused it

    const player = new YT.Player(holder, {
        videoId: s.id,
        width: "100%",
        height: "100%",
        playerVars: {
            autoplay: 1, mute: 1, playsinline: 1, origin: location.origin,
            controls: 0,          // hide YouTube's control bar
            disablekb: 1,         // disable YouTube's keyboard shortcuts
            fs: 0,                // hide YouTube's fullscreen button
            iv_load_policy: 3,    // hide annotations
            rel: 0,
            modestbranding: 1,
        },
        events: {
            onReady: () => syncSound(),
            onStateChange: (e) => {
                playBtn.textContent = e.data === YT.PlayerState.PLAYING ? "❚❚" : "▶";
                // the browser paused it in the background: resume (unless you paused it)
                if (e.data === YT.PlayerState.PAUSED && document.hidden && !userPaused) {
                    e.target.playVideo();
                }
            },
        },
    });

    const togglePlay = () => {
        if (player.getPlayerState() === YT.PlayerState.PLAYING) {
            userPaused = true;
            player.pauseVideo();
        } else {
            userPaused = false;
            player.playVideo();
        }
    };
    playBtn.onclick = togglePlay;
    shield.onclick = togglePlay;

    const resume = () => { if (!userPaused) player.playVideo?.(); };

    fsBtn.onclick = () =>
        document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.();

    // ---------- sound (each tile has its own) ----------
    let muted = true;                                  // autoplay requires starting muted

    function syncSound() {
        if (!player.setVolume) return;                 // player not ready yet
        if (muted) player.mute(); else player.unMute();
        player.setVolume(+vol.value);
        const v = +vol.value;
        muteBtn.textContent = muted || v === 0 ? "🔇" : v < 50 ? "🔉" : "🔊";
        muteBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    }

    muteBtn.onclick = () => {
        muted = !muted;
        if (!muted && +vol.value === 0) vol.value = 50;   // unmuting at 0 would be silent
        syncSound();
    };
    vol.oninput = () => {
        if (+vol.value > 0 && muted) muted = false;       // dragging the slider unmutes
        syncSound();
    };
    vol.onchange = () => vol.blur();                      // so arrow keys skip, not change volume

    // ---------- seeking ----------
    let dragging = false;
    let liveEdge = 0;                                  // furthest point seen, in seconds
    let snapUntil = 0;                                 // hold the bar at the end until this time

    function skip(sec) {
        if (!player.getCurrentTime) return;
        const dur = player.getDuration() || Infinity;
        const to = Math.min(Math.max(player.getCurrentTime() + sec, 0), dur);
        player.seekTo(to, true);
    }

    function goLive() {
        snapUntil = Date.now() + SNAP_MS;
        player.seekTo(Math.max(liveEdge, player.getDuration()), true);
        player.playVideo();
    }

    seek.onpointerdown = () => { dragging = true; };
    seek.onpointerup = () => { dragging = false; };
    seek.onpointercancel = () => { dragging = false; };
    seek.onchange = () => {
        const dur = Math.max(liveEdge, player.getDuration());
        if (+seek.value >= 985) {                      // dragged to the far right = go live
            snapUntil = Date.now() + SNAP_MS;
            seek.value = 1000;
            player.seekTo(dur, true);
        } else {
            player.seekTo(dur * seek.value / 1000, true);
        }
        dragging = false;
        seek.blur();                                   // so arrow keys skip, not move the slider
    };
    liveBtn.onclick = goLive;

    function tick() {
        if (!player.getCurrentTime || dragging) return;
        const dur = player.getDuration();
        if (!dur) return;
        const cur = player.getCurrentTime();
        const live = player.getVideoData?.().isLive;
        liveBtn.hidden = !live;

        if (live) {
            liveEdge = Math.max(liveEdge, dur, cur);   // the edge never moves backwards
            const atLive = liveEdge - cur < LIVE_TOLERANCE_S || Date.now() < snapUntil;
            liveBtn.classList.toggle("behind", !atLive);
            seek.value = atLive ? 1000 : Math.round(cur / liveEdge * 1000);
        } else {
            seek.value = Math.round(cur / dur * 1000);
        }
    }

    // ---------- hover (so arrow keys know which tile) ----------
    el.onmouseenter = () => { hovered = s.id; };
    el.onmouseleave = () => { if (hovered === s.id) hovered = null; };

    tiles.set(s.id, { el, nm, player, fsBtn, skip, tick, resume });
}


// ===== 7. MENU (left channel list) ===================================
function toggleChannel(c) {
    if (streams.some(s => s.id === c.id)) {
        streams = streams.filter(s => s.id !== c.id);      // uncheck: leave the wall
    } else {
        streams.push({ id: c.id, name: c.name });          // check: join the wall
    }
    save();
    render();
}

function deleteChannel(c) {
    library = library.filter(l => l.id !== c.id);
    streams = streams.filter(s => s.id !== c.id);
    saveLib();
    save();
    render();
}

function renderMenu() {
    list.innerHTML = "";

    library.forEach(c => {
        const onWall = streams.some(s => s.id === c.id);
        const row = make("div", "item" + (onWall ? " on" : ""));
        row.dataset.id = c.id;

        const badge = make("span", "badge", "LIVE");
        badge.hidden = !liveIds[c.id];

        const av = make("div", "avatar", (c.name || "?").charAt(0).toUpperCase());
        if (c.avatar) {
            const img = make("img");
            img.src = c.avatar;
            img.alt = "";
            img.onerror = () => img.remove();          // broken picture: keep the letter
            av.appendChild(img);
        }

        const del = mkBtn("✕", "Delete from list", "del");
        del.title = "Delete from list";
        del.onclick = (e) => {
            e.stopPropagation();                           // don't also toggle the row
            deleteChannel(c);
        };

        row.append(
            av,
            make("span", "name", c.name),
            badge,
            del,
            make("div", "check")
        );
        row.onclick = () => toggleChannel(c);
        list.appendChild(row);
    });
}

function updateBadges() {
    tiles.forEach((t, id) => {
        const badge = list.querySelector(`[data-id="${id}"] .badge`);
        if (badge) badge.hidden = !(liveIds[id] || t.player.getVideoData?.().isLive);
    });
}

async function refreshInfo() {
    const info = await getInfo(library.slice(0, 50).map(c => c.id));
    library.forEach(c => {
        const i = info[c.id];
        if (!i) return;
        liveIds[c.id] = i.live;
        if (i.avatar) c.avatar = i.avatar;
    });
    saveLib();
    renderMenu();
}

function setMenu(collapsed) {
    $("menu").classList.toggle("collapsed", collapsed);
    $("menuToggle").setAttribute("aria-label", collapsed ? "Expand menu" : "Collapse menu");
    localStorage.setItem("mv_menu_collapsed", collapsed ? "1" : "0");
}


// ===== 8. RENDER (draws the whole wall) ==============================
function render() {
    renderMenu();                                      // the menu works before the API loads
    if (!window.YT || !YT.Player) return;

    const n = streams.length;
    $("count").textContent = n + (n === 1 ? " stream" : " streams");

    // 1. remove tiles whose stream is gone
    for (const [id, t] of tiles) {
        if (!streams.some(s => s.id === id)) {
            t.player.destroy();
            t.el.remove();
            tiles.delete(id);
        }
    }

    // 2. create tiles for new streams only (so nothing else reloads)
    streams.forEach(s => { if (!tiles.has(s.id)) makeTile(s); });

    // 3. update names and order
    streams.forEach((s, i) => {
        const t = tiles.get(s.id);
        t.nm.textContent = s.name;
        t.el.style.setProperty("--i", i);
    });

    // 4. empty state
    if (!n) {
        grid.style.gridTemplateColumns = "1fr";
        if (!emptyEl) {
            emptyEl = make("div", "empty");
            emptyEl.innerHTML = "<h2>Nothing playing yet</h2><p>Add a YouTube link to start your wall.</p>";
        }
        grid.appendChild(emptyEl);
    } else if (emptyEl) {
        emptyEl.remove();
    }

    applyLayout();
    renderTabs();
}


// ===== 9. ADD-STREAM DIALOG ==========================================
const dlg = $("dlg");
const urlInput = $("url");
const errEl = $("err");

function openDlg() {
    urlInput.value = "";
    errEl.textContent = "";
    dlg.showModal();
    urlInput.focus();
}

async function addStream() {
    const id = parseId(urlInput.value);
    if (!id) {
        errEl.textContent = "That doesn't look like a YouTube link. Paste the full video or live URL.";
        return;
    }
    if (streams.some(s => s.id === id)) {
        errEl.textContent = "That stream is already on your wall.";
        return;
    }

    // 1. add right away with a temporary name, so nothing waits on the network
    const temp = "Stream " + (streams.length + 1);
    if (!library.some(l => l.id === id)) {
        library.push({ id, name: temp });
        saveLib();
    }
    streams.push({ id, name: temp });
    save();
    dlg.close();
    render();

    // 2. fetch the real name, picture and live status in the background
    const info = (await getInfo([id]))[id];
    const name = info?.channel || await getName(id, temp);
    const s = streams.find(x => x.id === id);
    const l = library.find(x => x.id === id);
    if (s) s.name = name;
    if (l) {
        l.name = name;
        if (info?.avatar) l.avatar = info.avatar;
    }
    if (info) liveIds[id] = info.live;
    save();
    saveLib();
    render();
}


// ===== 10. EVENTS ====================================================
$("add").onclick = openDlg;
$("cancel").onclick = () => dlg.close();
$("ok").onclick = addStream;
urlInput.onkeydown = (e) => { if (e.key === "Enter") addStream(); };
urlInput.oninput = () => { errEl.textContent = ""; };
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });   // click outside

$("toggle").onclick = () => {
    const hidden = $("side").classList.toggle("hidden");
    $("toggle").textContent = hidden ? "Show chat" : "Hide chat";
};

$("clear").onclick = () => {
    if ((streams.length || library.length) && confirm("Remove all streams and clear the channel list?")) {
        streams = [];
        library = [];
        active = null;
        save();
        saveLib();
        render();
    }
};

$("layout").onclick = () => {
    layout = layout === "focus" ? "grid" : "focus";
    localStorage.setItem("mv_layout", layout);
    applyLayout();
};

$("menuToggle").onclick = () => setMenu(!$("menu").classList.contains("collapsed"));

// chat tabs scroll sideways with the mouse wheel
$("tabs").addEventListener("wheel", (e) => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    e.currentTarget.scrollLeft += e.deltaY;
}, { passive: false });

// arrow keys skip on the hovered tile (or the active one)
document.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tag = e.target.tagName;
    if (tag === "TEXTAREA" || (tag === "INPUT" && e.target.type === "text")) return;

    const t = tiles.get(hovered) || tiles.get(active);
    if (!t) return;
    e.preventDefault();                                // stop the page scrolling sideways
    t.skip(e.key === "ArrowRight" ? SKIP_S : -SKIP_S);
});

document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tiles.forEach(t => t.resume());
});

document.addEventListener("fullscreenchange", () => {
    tiles.forEach(t => {
        const isFs = document.fullscreenElement === t.el;
        t.fsBtn.textContent = isFs ? "✕" : "⛶";
        t.fsBtn.setAttribute("aria-label", isFs ? "Exit fullscreen" : "Fullscreen");
    });
});


// ===== 11. START =====================================================
setMenu(localStorage.getItem("mv_menu_collapsed") === "1");
setInterval(() => tiles.forEach(t => t.tick()), TICK_MS);
setInterval(updateBadges, BADGE_MS);
refreshInfo();                                         // fill in pictures for saved channels
setInterval(() => { if (!document.hidden) refreshInfo(); }, INFO_MS);

window.onYouTubeIframeAPIReady = render;               // YouTube calls this when its API is ready
render();                                              // also draw now (render waits if the API isn't ready)
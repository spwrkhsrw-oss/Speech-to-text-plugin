(function () {
  const { metro, ui, plugin, patcher } = vendetta;
  const { findByProps, findByStoreName } = metro;
  const { React, ReactNative: RN } = metro.common;
  const storage = plugin.storage;

  const defaults = {
    enabled: true,
    provider: "gemini", // "gemini" | "openrouter"
    geminiKey: "",
    geminiModel: "gemini-2.5-flash",
    openrouterKey: "",
    openrouterModel: "google/gemini-2.5-flash",
    language: "",
  };
  for (const k in defaults) if (storage[k] === undefined) storage[k] = defaults[k];

  const unpatches = [];
  const listeners = new Set();
  const logs = [];
  const toast = (t) => { try { ui.toasts.showToast(t); } catch (e) {} };
  function log(m) {
    logs.push(String(m));
    if (logs.length > 60) logs.shift();
    listeners.forEach((f) => f());
  }

  const AUDIO_RE = /\.(ogg|opus|m4a|aac|mp3|wav|webm|3gp)(\?|$)/i;
  const MIME = { ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", wav: "audio/wav", webm: "audio/webm", "3gp": "audio/3gpp" };

  const URI_KEYS = /^(uri|path|filepath|localuri|fileuri|file|url)$/i;
  function findAudioUri(v, key = "", depth = 0) {
    if (depth > 3 || v == null) return null;
    if (typeof v === "string") {
      const isPath = v.startsWith("file://") || v.startsWith("/");
      if (!isPath) return null;
      return AUDIO_RE.test(v) || (URI_KEYS.test(key) && v.startsWith("file://") && /voice|record|audio/i.test(v)) ? v : null;
    }
    if (typeof v !== "object") return null;
    try {
      for (const k of Object.keys(v)) {
        const r = findAudioUri(v[k], k, depth + 1);
        if (r) return r;
      }
    } catch (e) {}
    return null;
  }

  function toBase64(fileUri) {
    return fetch(fileUri)
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onloadend = () => resolve(String(fr.result).split(",")[1]);
            fr.onerror = reject;
            fr.readAsDataURL(blob);
          })
      );
  }

  async function transcribe(uri) {
    const fileUri = uri.startsWith("/") ? "file://" + uri : uri;
    const ext = (fileUri.match(AUDIO_RE)?.[1] ?? "ogg").toLowerCase();
    const mime = MIME[ext] ?? "audio/ogg";
    const data = await toBase64(fileUri);
    const prompt =
      "Transcribe this voice message exactly as spoken" +
      (storage.language ? ` (language: ${storage.language})` : "") +
      ". Output only the transcript text, with no quotes, labels or commentary. If there is no speech, output nothing.";

    let text;
    if (storage.provider === "openrouter") {
      if (!storage.openrouterKey) throw new Error("No OpenRouter key yet. Open Settings > Plugins > Voice to Text > gear icon.");
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${storage.openrouterKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: storage.openrouterModel,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "input_audio", input_audio: { data, format: ext === "opus" ? "ogg" : ext } }] }],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 150)}`);
      const c = (await res.json()).choices?.[0]?.message?.content;
      text = Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : c;
    } else {
      if (!storage.geminiKey) throw new Error("No Gemini key yet. Open Settings > Plugins > Voice to Text > gear icon.");
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(String(storage.geminiModel).replace(/^models\//, ""))}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": storage.geminiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }] }),
        }
      );
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 150)}`);
      text = (await res.json()).candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
    }
    text = (text ?? "").trim();
    if (!text) throw new Error("Empty transcript");
    return text;
  }

  const choose = (title, message, buttons) =>
    new Promise((resolve) =>
      RN.Alert.alert(
        title,
        message,
        buttons.map((b) => ({ text: b.text, style: b.style, onPress: () => resolve(b.value) })),
        { cancelable: false }
      )
    );

  const recentVoice = new Map(); // uri -> time, so a nested patched call doesn't ask twice
  const asking = new Set();

  function chunk(text, size = 2000) {
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  // Not async on purpose: calls without audio are passed straight through with the original return value.
  function intercept(args, orig) {
    if (!storage.enabled) return orig(...args);
    const uri = findAudioUri(args);
    if (!uri) return orig(...args);
    const seen = recentVoice.get(uri);
    if (asking.has(uri) || (seen && Date.now() - seen < 60000)) return orig(...args);
    return ask(uri, args, orig);
  }

  async function ask(uri, args, orig) {
    asking.add(uri);
    try {
      const pick = await choose("Send voice message", "How do you want to send it?", [
        { text: "Send as voice", value: "voice" },
        { text: "Send as text", value: "text" },
        { text: "Cancel", value: "cancel", style: "cancel" },
      ]);
      if (pick === "cancel") return;
      if (pick === "voice") { recentVoice.set(uri, Date.now()); return orig(...args); }

      try {
        toast("Transcribing...");
        const text = await transcribe(uri);
        const channelId = findByStoreName("SelectedChannelStore")?.getChannelId?.();
        const api = findByProps("getAPIBaseURL", "post") ?? findByProps("HTTP")?.HTTP;
        if (!channelId || !api) throw new Error("Could not find channel or REST module");
        for (const part of chunk(text)) {
          await api.post({ url: `/channels/${channelId}/messages`, body: { content: part } });
        }
        log("Sent as text: " + text.slice(0, 60));
      } catch (e) {
        log("Error: " + (e?.message ?? e));
        const fallback = await choose("Transcription failed", String(e?.message ?? e), [
          { text: "Send as voice instead", value: "voice" },
          { text: "Cancel", value: "cancel", style: "cancel" },
        ]);
        if (fallback === "voice") { recentVoice.set(uri, Date.now()); return orig(...args); }
      }
    } finally {
      asking.delete(uri);
    }
  }

  // Find functions in already-loaded modules whose name looks like sending/uploading a voice message.
  function scan() {
    const found = [];
    const mods = metro.modules ?? {};
    for (const id in mods) {
      try {
        const m = mods[id];
        if (!m?.isInitialized) continue;
        const ex = m.publicModule?.exports;
        if (!ex || typeof ex !== "object") continue;
        for (const holder of [ex, ex.default]) {
          if (!holder || typeof holder !== "object") continue;
          for (const key of Object.keys(holder)) {
            if (typeof holder[key] !== "function") continue;
            if (/voice.?message/i.test(key) || /voice.?(note|recording)/i.test(key)) found.push({ id, holder, key });
          }
        }
      } catch (e) {}
    }
    return found;
  }

  const SEND_RE = /(send|upload|submit|post).*voice|voice.*(send|upload|submit|post)/i;

  const patched = new WeakMap(); // holder -> Set(keys)
  const timers = [];

  function install(quiet) {
    const found = scan();
    const targets = found.filter((f) => SEND_RE.test(f.key));
    let added = 0;
    targets.forEach((t) => {
      const keys = patched.get(t.holder) ?? new Set();
      if (keys.has(t.key)) return;
      try {
        unpatches.push(patcher.instead(t.key, t.holder, (args, orig) => intercept(args, orig)));
        keys.add(t.key);
        patched.set(t.holder, keys);
        added++;
        log(`Patched ${t.key} (module ${t.id})`);
      } catch (e) {
        log(`Could not patch ${t.key}: ${e?.message ?? e}`);
      }
    });
    if (!quiet) log(`Voice-related functions: ${found.length}, newly patched: ${added}`);
    return added;
  }

  // Discord loads many modules lazily, so keep looking for a while after startup.
  function scheduleScans() {
    [3000, 10000, 25000, 60000].forEach((ms) => timers.push(setTimeout(() => install(true), ms)));
  }

  // ---- native-style settings UI (Discord "Forms" components, with plain fallbacks) ----
  const h = React.createElement;
  const Forms = ui.components?.Forms ?? {};
  const T = (extra) => ({ color: "#B5BAC1", ...extra });
  const textOf = (v) => (typeof v === "string" ? v : v?.nativeEvent?.text ?? "");

  const Section = (title, ...kids) =>
    Forms.FormSection
      ? h(Forms.FormSection, { title }, ...kids)
      : h(RN.View, { style: { marginBottom: 14, paddingHorizontal: 12 } }, h(RN.Text, { style: T({ fontWeight: "700", marginBottom: 6 }) }, title), ...kids);

  const Row = (label, subLabel, onPress, trailing) =>
    Forms.FormRow
      ? h(Forms.FormRow, { label, subLabel, onPress, trailing: trailing ?? (onPress ? Forms.FormRow.Arrow : undefined) })
      : h(RN.Pressable, { onPress, style: { paddingVertical: 10 } },
          h(RN.Text, { style: { color: "#fff", fontWeight: "600" } }, label),
          subLabel ? h(RN.Text, { style: T({ fontSize: 12 }) }, subLabel) : null);

  const Toggle = (label, subLabel, value, onValueChange) =>
    Forms.FormSwitchRow
      ? h(Forms.FormSwitchRow, { label, subLabel, value, onValueChange })
      : h(RN.View, { style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 } },
          h(RN.View, { style: { flex: 1 } }, h(RN.Text, { style: { color: "#fff" } }, label), subLabel ? h(RN.Text, { style: T({ fontSize: 12 }) }, subLabel) : null),
          h(RN.Switch, { value, onValueChange }));

  function Input({ title, k, secure, placeholder }) {
    const [v, setV] = React.useState(storage[k] ?? "");
    const set = (x) => { const t = textOf(x); storage[k] = t; setV(t); };
    return Forms.FormInput
      ? h(Forms.FormInput, { title, value: v, placeholder, onChange: set, onChangeText: set, secureTextEntry: !!secure, autoCapitalize: "none", autoCorrect: false })
      : h(RN.View, { style: { marginBottom: 10 } },
          h(RN.Text, { style: T({ marginBottom: 4 }) }, title),
          h(RN.TextInput, { value: v, placeholder, secureTextEntry: !!secure, autoCapitalize: "none", autoCorrect: false, onChangeText: set,
            style: { color: "#fff", backgroundColor: "#1E1F22", borderRadius: 8, padding: 10 } }));
  }

  async function testKey() {
    const gem = storage.provider !== "openrouter";
    const key = gem ? storage.geminiKey : storage.openrouterKey;
    if (!key) return toast("Enter an API key first");
    toast("Testing key...");
    try {
      const res = gem
        ? await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key } })
        : await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 80)}`);
      toast("API key works");
      log("API key test passed");
    } catch (e) {
      toast("Key test failed: " + (e?.message ?? e));
      log("Key test failed: " + (e?.message ?? e));
    }
  }

  function Settings() {
    const [, bump] = React.useState(0);
    const [enabled, setEnabled] = React.useState(!!storage.enabled);
    const [provider, setProvider] = React.useState(storage.provider);
    React.useEffect(() => {
      const f = () => bump((n) => n + 1);
      listeners.add(f);
      return () => listeners.delete(f);
    }, []);
    const pick = (p) => () => { storage.provider = p; setProvider(p); };
    const tick = (on) => (on ? h(RN.Text, { style: { color: "#23A55A", fontWeight: "700", fontSize: 18 } }, "\u2713") : undefined);

    return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 40 } },
      Section("General",
        Toggle("Ask before sending voice messages", "Choose voice or text after you record", enabled, (v) => { storage.enabled = v; setEnabled(v); })),
      Section("Transcription provider",
        Row("Gemini", "Google AI Studio key, direct", pick("gemini"), tick(provider === "gemini") ?? h(RN.View)),
        Row("OpenRouter", "One key, many models", pick("openrouter"), tick(provider === "openrouter") ?? h(RN.View))),
      ...(provider === "gemini"
        ? [Section("Gemini",
            h(Input, { title: "API key", k: "geminiKey", secure: true, placeholder: "AIza..." }),
            h(Input, { title: "Model", k: "geminiModel", placeholder: "gemini-2.5-flash" }))]
        : [Section("OpenRouter",
            h(Input, { title: "API key", k: "openrouterKey", secure: true, placeholder: "sk-or-..." }),
            h(Input, { title: "Model", k: "openrouterModel", placeholder: "google/gemini-2.5-flash" }))]),
      Section("Options", h(Input, { title: "Language hint (optional)", k: "language", placeholder: "e.g. English" })),
      Section("Tools",
        Row("Test API key", "Checks the key for the selected provider", testKey),
        Row("Rescan and patch", "Look for Discord's voice message functions again", () => { if (!install()) log("Nothing new to patch."); }),
        Row("List voice functions", "Shows what was found; send me this if it isn't working", () => {
          const f = scan();
          log(`Found ${f.length}:`);
          f.slice(0, 25).forEach((x) => log(`${x.key} (module ${x.id})`));
        })),
      Section("Log", h(RN.Text, { selectable: true, style: T({ fontFamily: "monospace", padding: 12 }) }, logs.join("\n") || "Nothing yet."))
    );
  }

  return {
    default: {
      onLoad() {
        install();
        scheduleScans();
        const hasKey = storage.provider === "openrouter" ? storage.openrouterKey : storage.geminiKey;
        if (!hasKey) toast("Voice to Text: tap the gear icon in Plugins to add your API key");
      },
      onUnload() { timers.forEach(clearTimeout); timers.length = 0; unpatches.forEach((u) => u()); unpatches.length = 0; },
      settings: Settings,
    },
  };
})()

// Text-to-speech providers. One interface, so the voice can be swapped without touching the host:
//
//   provider = { id, label, available(): boolean, speak(text, { onWord?(charIndex), signal? }): Promise<void>, cancel() }
//
// - browser: the Web Speech API (speechSynthesis). Works offline; voices vary by OS and browser.
// - http:    POST { text, voice } to any endpoint that answers with audio (for example an Amazon Polly proxy;
//            the CLI forwards /tts to `--tts-url`). Word timing is estimated from playback progress.
// - captions: no audio at all, captions only (handy in open-plan offices and in CI screenshots).

export function createBrowserTts({ lang = 'en-US', rate = 1.02, prefer = /Samantha|Ava|Google US English|Jenny|Aria|Allison/ } = {}) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  let timer = 0;
  return {
    id: 'browser',
    label: 'Browser voice',
    available: () => Boolean(synth && window.SpeechSynthesisUtterance),
    speak(text, { onWord, signal } = {}) {
      if (!this.available() || !text) return Promise.resolve();
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang; u.rate = rate;
        const v = synth.getVoices().find((x) => x.lang?.replace('_', '-').startsWith(lang) && prefer.test(x.name)) || synth.getVoices().find((x) => x.lang?.replace('_', '-').startsWith(lang));
        if (v) u.voice = v;
        const done = () => { clearTimeout(timer); resolve(); };
        u.onboundary = (e) => onWord?.(e.charIndex);
        u.onend = done; u.onerror = done;
        signal?.addEventListener('abort', () => { synth.cancel(); done(); }, { once: true });
        // never stay stuck in "speaking" when a browser drops the end event
        timer = setTimeout(done, Math.max(4000, text.split(/\s+/).length * 520));
        synth.cancel();
        synth.speak(u);
      });
    },
    cancel() { clearTimeout(timer); synth?.cancel(); },
  };
}

export function createHttpTts({ url, headers = {}, voice } = {}) {
  let audio = null;
  return {
    id: 'http',
    label: 'Server voice',
    available: () => Boolean(url),
    async speak(text, { onWord, signal } = {}) {
      if (!text) return;
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text, voice }), signal });
      if (!r.ok) throw new Error(`TTS endpoint answered HTTP ${r.status}`);
      const src = URL.createObjectURL(await r.blob());
      audio = new Audio(src);
      audio.ontimeupdate = () => { if (audio?.duration) onWord?.(Math.floor((audio.currentTime / audio.duration) * text.length)); };
      signal?.addEventListener('abort', () => audio?.pause(), { once: true });
      try {
        await audio.play();
        await new Promise((res) => { audio.onended = res; audio.onpause = res; audio.onerror = res; });
      } finally { URL.revokeObjectURL(src); audio = null; }
    },
    cancel() { audio?.pause(); },
  };
}

export function createCaptionsOnly() {
  return { id: 'captions', label: 'Captions only', available: () => true, speak: () => Promise.resolve(), cancel() {} };
}

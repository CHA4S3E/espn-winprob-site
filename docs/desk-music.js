// desk-music.js -- the News Desk's soundtrack, composed live in the browser.
//
// No audio files: every song is generated from a style (one per studio and
// time of day) by picking a key, tempo, chord progressions, drum and bass
// patterns, instrument tones and a melody motif at random, then arranging
// them into sections (intro, verse, chorus, breakdown...). A new song starts
// every couple of minutes, so it doesn't loop. Stings (breaking news, upset,
// final, touchdown, lead change, handoff) are short phrases in the same
// studio's sound, and the music ducks under them.
//
//   DeskMusic.start()                 call from a click (browsers require it)
//   DeskMusic.setStyle('pro', 'night') studio: pro|casual, daypart: day|night
//   DeskMusic.sting('breaking')       breaking|upset|final|td|bad|lead|handoff|alert
//   DeskMusic.setVolume(0..1), DeskMusic.stop(), DeskMusic.nowPlaying()
(function () {
  'use strict';
  let ctx = null, master, comp, musicBus, duckGain, sfxBus, reverb, revSend, noiseBuf;
  let running = false, timer = null;
  let style = null, styleKey = 'pro-day', pendingStyle = null;
  let song = null, nextStepTime = 0, step = 0, songStart = 0;
  let volume = 0.55;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ---------------------------------------------------------------- scales & harmony
  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
    mixolydian: [0, 2, 4, 5, 7, 9, 10], harmonicMinor: [0, 2, 3, 5, 7, 8, 11], lydian: [0, 2, 4, 6, 7, 9, 11],
  };
  // Degree (0-based) -> chord tones in the scale, with optional 7th.
  function chordNotes(root, scale, degree, seventh) {
    const s = SCALES[scale], notes = [];
    for (const k of seventh ? [0, 2, 4, 6] : [0, 2, 4]) {
      const idx = degree + k, oct = Math.floor(idx / 7);
      notes.push(root + s[idx % 7] + 12 * oct);
    }
    return notes;
  }

  // ---------------------------------------------------------------- styles
  // Drum patterns: 16 steps per bar. k kick, s snare, h hat, o open hat, c clap, t tom, x shaker.
  const STYLES = {
    'pro-day': {
      name: 'Studio Daylight', tempo: [112, 128], swing: 0, scales: ['major', 'major', 'mixolydian'], roots: [55, 57, 58, 60, 62],
      progs: [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 4, 4], [0, 2, 3, 4], [3, 4, 0, 0], [0, 4, 3, 4], [5, 4, 3, 4], [0, 6, 3, 4], [3, 0, 4, 5]],
      drums: [
        { k: 'x...x...x...x...', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', o: '..............x.' },
        { k: 'x.....x.x.......', s: '....x.......x..x', h: 'xxxxxxxxxxxxxxxx', o: '' },
        { k: 'x..x..x...x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', o: '......x.......x.' },
        { k: 'x...x...x...x.x.', s: '....x..x....x...', h: '..x...x...x...x.', c: '....x.......x...' },
      ],
      bass: ['x.x.x.x.x.x.x.x.', 'x..x..x.x..x..x.', 'x...x.x.x...x.x.', 'x.xx..x.x.xx..x.'],
      comp: { inst: 'brass', rhythms: ['x.....x.....x...', 'x..x..x.........', '....x.......x...', 'x.......x..x....'] },
      lead: { inst: 'lead', density: 0.5, octave: 12 }, pad: 'strings', seventh: false, bassInst: 'pickBass',
    },
    'pro-night': {
      name: 'Primetime', tempo: [88, 104], swing: 0, scales: ['minor', 'dorian', 'minor'], roots: [50, 52, 53, 55, 57],
      progs: [[0, 5, 3, 4], [0, 3, 5, 4], [0, 6, 5, 4], [0, 5, 6, 4], [3, 4, 0, 0], [0, 3, 0, 4], [5, 6, 0, 0], [0, 2, 3, 4], [0, 6, 3, 4]],
      drums: [
        { k: 'x.......x.x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', t: '..............xx' },
        { k: 'x..x....x.......', s: '....x.......x...', h: 'x.xxx.x.x.xxx.x.', o: '' },
        { k: 'x.....x...x.....', s: '....x.......x...', h: '..x...x...x...x.', t: '............x.x.' },
        { k: 'x.......x.......', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', c: '............x...' },
      ],
      bass: ['x.......x.......', 'x..x....x..x....', 'x.....x.x.......', 'x...x...x...x...'],
      comp: { inst: 'arp', rhythms: ['xxxxxxxxxxxxxxxx', 'x.x.x.x.x.x.x.x.', 'x.xxx.xxx.xxx.xx'] },
      lead: { inst: 'softKeys', density: 0.3, octave: 12 }, pad: 'darkPad', seventh: true, bassInst: 'subBass',
    },
    'casual-day': {
      name: 'Front Porch', tempo: [96, 116], swing: 0.12, scales: ['major'], roots: [55, 57, 60, 62, 64],
      progs: [[0, 3, 4, 3], [0, 4, 5, 3], [0, 3, 0, 4], [3, 4, 0, 5], [0, 1, 4, 0], [0, 5, 1, 4], [0, 3, 1, 4], [0, 4, 3, 0], [5, 3, 0, 4]],
      drums: [
        { k: 'x.......x.......', s: '....x.......x...', x: 'x.x.x.x.x.x.x.x.', c: '' },
        { k: 'x.....x.x.......', c: '....x.......x...', x: 'xxxxxxxxxxxxxxxx' },
        { k: 'x.......x..x....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
        { k: 'x...x...x...x...', c: '....x.......x...', x: '..x...x...x...x.' },
      ],
      bass: ['x...x...x...x...', 'x.....x.x.......', 'x...x.x.x...x...', 'x..x..x.x...x...'],
      comp: { inst: 'uke', rhythms: ['x.x.x.xxx.x.x.xx', 'x..x..x.x..x..x.', '..x...x...x...x.', 'x.xx.xx.x.xx.xx.'] },
      lead: { inst: 'marimba', density: 0.55, octave: 12 }, pad: null, seventh: false, bassInst: 'upright',
    },
    'champ': {
      name: 'Championship Anthem', tempo: [84, 94], swing: 0, scales: ['minor', 'major'], roots: [50, 52, 53, 55],
      progs: [[0, 5, 3, 4], [0, 3, 4, 4], [5, 3, 0, 4], [0, 5, 2, 4], [3, 4, 0, 0]],
      drums: [
        { k: 'x.......x.x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.', t: '............x.x.' },
        { k: 'x.....x.x.......', s: '....x.......x...', c: '....x.......x...', h: 'x...x...x...x...', t: '..............xx' },
      ],
      bass: ['x.......x.......', 'x.....x.x.......'],
      comp: { inst: 'brass', rhythms: ['x...............', 'x.......x.......', 'x.....x.........'] },
      lead: { inst: 'softKeys', density: 0.35, octave: 12 }, pad: 'strings', seventh: false, bassInst: 'subBass',
    },
    'casual-night': {
      name: 'Couch Lo-Fi', tempo: [70, 86], swing: 0.22, scales: ['dorian', 'major'], roots: [50, 52, 53, 55, 57],
      progs: [[1, 4, 0, 0], [0, 5, 1, 4], [3, 2, 1, 0], [1, 4, 0, 5], [0, 3, 1, 4], [5, 1, 4, 0], [3, 4, 2, 5]],
      drums: [
        { k: 'x.........x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
        { k: 'x......x..x.....', s: '....x.......x...', h: 'x.xxx.x.x.xxx.x.' },
        { k: 'x.....x...x..x..', s: '....x.......x...', h: '..x...x...x...x.' },
      ],
      bass: ['x.......x.......', 'x.....x...x.....', 'x..x......x.....'],
      comp: { inst: 'rhodes', rhythms: ['x.......x.......', 'x.....x...x.....', '..x.......x.....'] },
      lead: { inst: 'flute', density: 0.25, octave: 12 }, pad: 'warmPad', seventh: true, bassInst: 'subBass', vinyl: true,
    },
  };

  // ---------------------------------------------------------------- audio plumbing
  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = volume;
    comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = 0.8;
    duckGain = ctx.createGain(); duckGain.gain.value = 1;
    musicBus.connect(duckGain); duckGain.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.55; // stings sit under the music, not on top of it sfxBus.connect(master);
    // Reverb from a generated impulse response.
    reverb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.2, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    reverb.buffer = ir;
    revSend = ctx.createGain(); revSend.gain.value = 0.22;
    revSend.connect(reverb); reverb.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }
  function out(node, bus, wet) {
    node.connect(bus || musicBus);
    if (wet) { const g = ctx.createGain(); g.gain.value = wet; node.connect(g); g.connect(revSend); }
  }
  function env(g, t, a, peak, d, sustain, r, end) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * sustain), t + a + d);
    g.gain.setValueAtTime(Math.max(0.0001, peak * sustain), end);
    g.gain.exponentialRampToValueAtTime(0.0001, end + r);
  }
  function noise(t, dur) { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.start(t, Math.random() * 0.5); s.stop(t + dur); return s; }

  // ---------------------------------------------------------------- instruments
  const tone = { bright: 1, detune: 6 }; // per-song timbre tweaks
  const INST = {
    kick(t, v = 1, bus) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12); env(g, t, 0.002, 0.9 * v, 0.18, 0.001, 0.05, t + 0.2); o.connect(g); out(g, bus); o.start(t); o.stop(t + 0.35); },
    snare(t, v = 1, bus) { const n = noise(t, 0.25), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7; env(g, t, 0.001, 0.45 * v, 0.12, 0.001, 0.05, t + 0.14); n.connect(f); f.connect(g); out(g, bus, 0.3); const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = 190; env(og, t, 0.001, 0.25 * v, 0.07, 0.001, 0.02, t + 0.08); o.connect(og); out(og, bus); o.start(t); o.stop(t + 0.15); },
    clap(t, v = 1, bus) { for (let i = 0; i < 3; i++) { const tt = t + i * 0.012, n = noise(tt, 0.2), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 1.2; env(g, tt, 0.001, 0.32 * v, i === 2 ? 0.15 : 0.02, 0.001, 0.03, tt + (i === 2 ? 0.16 : 0.025)); n.connect(f); f.connect(g); out(g, bus, 0.35); } },
    hat(t, v = 1, bus, open) { const n = noise(t, open ? 0.35 : 0.06), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = 'highpass'; f.frequency.value = 7500; env(g, t, 0.001, 0.16 * v, open ? 0.25 : 0.04, 0.001, 0.02, t + (open ? 0.27 : 0.05)); n.connect(f); f.connect(g); out(g, bus); },
    shaker(t, v = 1, bus) { const n = noise(t, 0.08), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = 'bandpass'; f.frequency.value = 6000; f.Q.value = 2; env(g, t, 0.015, 0.09 * v, 0.04, 0.001, 0.02, t + 0.06); n.connect(f); f.connect(g); out(g, bus); },
    tom(t, v = 1, bus, pitch = 110) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(pitch * 1.6, t); o.frequency.exponentialRampToValueAtTime(pitch, t + 0.15); env(g, t, 0.002, 0.6 * v, 0.3, 0.001, 0.1, t + 0.32); o.connect(g); out(g, bus, 0.3); o.start(t); o.stop(t + 0.5); },
    boom(t, v = 1, bus) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.8); env(g, t, 0.003, 1.0 * v, 0.9, 0.001, 0.2, t + 0.9); o.connect(g); out(g, bus, 0.5); o.start(t); o.stop(t + 1.3); const n = noise(t, 0.6), f = ctx.createBiquadFilter(), ng = ctx.createGain(); f.type = 'lowpass'; f.frequency.value = 900; env(ng, t, 0.001, 0.3 * v, 0.5, 0.001, 0.1, t + 0.5); n.connect(f); f.connect(ng); out(ng, bus, 0.6); },
    whoosh(t, dur = 0.8, v = 1, bus, up = true) { const n = noise(t, dur + 0.1), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = 'bandpass'; f.Q.value = 3; f.frequency.setValueAtTime(up ? 300 : 5000, t); f.frequency.exponentialRampToValueAtTime(up ? 6000 : 300, t + dur); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35 * v, t + dur * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); n.connect(f); f.connect(g); out(g, bus, 0.6); },
    vinyl(t, dur, bus) { const n = noise(t, dur), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = 'bandpass'; f.frequency.value = 3000; f.Q.value = 0.4; g.gain.value = 0.012; n.connect(f); f.connect(g); out(g, bus); },

    pickBass(t, m, d, v = 1, bus) { const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'sawtooth'; o.frequency.value = mtof(m); f.type = 'lowpass'; f.frequency.setValueAtTime(1400 * tone.bright, t); f.frequency.exponentialRampToValueAtTime(260, t + 0.15); env(g, t, 0.004, 0.36 * v, 0.12, 0.5, 0.06, t + d); o.connect(f); f.connect(g); out(g, bus); o.start(t); o.stop(t + d + 0.1); },
    subBass(t, m, d, v = 1, bus) { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = mtof(m); env(g, t, 0.01, 0.5 * v, 0.2, 0.7, 0.12, t + d); o.connect(g); out(g, bus); o.start(t); o.stop(t + d + 0.2); },
    upright(t, m, d, v = 1, bus) { const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.value = mtof(m); f.type = 'lowpass'; f.frequency.value = 900; env(g, t, 0.006, 0.5 * v, 0.25, 0.2, 0.08, t + Math.min(d, 0.4)); o.connect(f); f.connect(g); out(g, bus); o.start(t); o.stop(t + d + 0.2); },

    brass(t, notes, d, v = 1, bus) { for (const m of notes) for (const det of [-tone.detune, tone.detune]) { const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det; f.type = 'lowpass'; f.frequency.setValueAtTime(400, t); f.frequency.linearRampToValueAtTime(2600 * tone.bright, t + 0.05); f.frequency.exponentialRampToValueAtTime(900, t + d); env(g, t, 0.02, 0.07 * v, 0.1, 0.6, 0.12, t + d); o.connect(f); f.connect(g); out(g, bus, 0.25); o.start(t); o.stop(t + d + 0.2); } },
    strings(t, notes, d, v = 1, bus) { for (const m of notes) for (const det of [-9, 0, 9]) { const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det; f.type = 'lowpass'; f.frequency.value = 1400; env(g, t, 0.4, 0.022 * v, 0.3, 0.8, 0.6, t + d); o.connect(f); f.connect(g); out(g, bus, 0.5); o.start(t); o.stop(t + d + 0.8); } },
    darkPad(t, notes, d, v = 1, bus) { for (const m of notes) for (const det of [-12, 12]) { const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'sawtooth'; o.frequency.value = mtof(m - 12); o.detune.value = det; f.type = 'lowpass'; f.frequency.setValueAtTime(300, t); f.frequency.linearRampToValueAtTime(900, t + d / 2); f.frequency.linearRampToValueAtTime(350, t + d); env(g, t, 0.8, 0.03 * v, 0.4, 0.8, 0.8, t + d); o.connect(f); f.connect(g); out(g, bus, 0.6); o.start(t); o.stop(t + d + 1); } },
    warmPad(t, notes, d, v = 1, bus) { for (const m of notes) { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.value = mtof(m); env(g, t, 0.6, 0.035 * v, 0.4, 0.8, 0.7, t + d); o.connect(g); out(g, bus, 0.6); o.start(t); o.stop(t + d + 1); } },
    arp(t, m, d, v = 1, bus) { const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'square'; o.frequency.value = mtof(m); f.type = 'lowpass'; f.frequency.value = 1800 * tone.bright; env(g, t, 0.003, 0.05 * v, 0.12, 0.001, 0.05, t + 0.13); o.connect(f); f.connect(g); out(g, bus, 0.4); o.start(t); o.stop(t + 0.3); },
    uke(t, notes, d, v = 1, bus) { notes.forEach((m, i) => { const tt = t + i * 0.012, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.value = mtof(m + 12); f.type = 'lowpass'; f.frequency.value = 3000; env(g, tt, 0.002, 0.06 * v, 0.25, 0.001, 0.05, tt + 0.28); o.connect(f); f.connect(g); out(g, bus, 0.2); o.start(tt); o.stop(tt + 0.45); }); },
    rhodes(t, notes, d, v = 1, bus) { for (const m of notes) { const c = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain(); c.type = 'sine'; c.frequency.value = mtof(m); mod.frequency.value = mtof(m) * 2; mg.gain.setValueAtTime(mtof(m) * 1.2, t); mg.gain.exponentialRampToValueAtTime(5, t + 0.6); mod.connect(mg); mg.connect(c.frequency); env(g, t, 0.005, 0.07 * v, 0.9, 0.3, 0.4, t + d); c.connect(g); out(g, bus, 0.45); c.start(t); mod.start(t); c.stop(t + d + 0.6); mod.stop(t + d + 0.6); } },
    marimba(t, m, d, v = 1, bus) { for (const [mult, amp, dec] of [[1, 0.22, 0.5], [4, 0.05, 0.08], [10, 0.015, 0.03]]) { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = mtof(m) * mult; env(g, t, 0.002, amp * v, dec, 0.001, 0.02, t + dec); o.connect(g); out(g, bus, 0.25); o.start(t); o.stop(t + dec + 0.1); } },
    softKeys(t, m, d, v = 1, bus) { const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'sine'; o2.type = 'triangle'; o.frequency.value = mtof(m); o2.frequency.value = mtof(m); o2.detune.value = 4; f.type = 'lowpass'; f.frequency.setValueAtTime(1600, t); f.frequency.exponentialRampToValueAtTime(700, t + Math.max(0.2, d)); env(g, t, 0.015, 0.045 * v, 0.35, 0.45, 0.25, t + d); o.connect(f); o2.connect(f); f.connect(g); out(g, bus, 0.35); o.start(t); o2.start(t); o.stop(t + d + 0.4); o2.stop(t + d + 0.4); },
    bell(t, m, d, v = 1, bus) { for (const [mult, amp] of [[1, 0.045], [2.76, 0.012], [5.4, 0.005]]) { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = mtof(m) * mult; env(g, t, 0.002, amp * v, 1.2 / mult, 0.001, 0.1, t + 1.2 / mult); o.connect(g); out(g, bus, 0.6); o.start(t); o.stop(t + 1.6); } },
    lead(t, m, d, v = 1, bus) { const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain(); o.type = 'square'; o.frequency.value = mtof(m); lfo.frequency.value = 5.5; lg.gain.value = 6; lfo.connect(lg); lg.connect(o.detune); f.type = 'lowpass'; f.frequency.value = 1700 * tone.bright; env(g, t, 0.02, 0.04 * v, 0.1, 0.7, 0.1, t + d); o.connect(f); f.connect(g); out(g, bus, 0.3); o.start(t); lfo.start(t); o.stop(t + d + 0.2); lfo.stop(t + d + 0.2); },
    flute(t, m, d, v = 1, bus) { const o = ctx.createOscillator(), g = ctx.createGain(), n = noise(t, d + 0.1), nf = ctx.createBiquadFilter(), ng = ctx.createGain(); o.type = 'sine'; o.frequency.value = mtof(m); env(g, t, 0.06, 0.08 * v, 0.1, 0.8, 0.15, t + d); nf.type = 'bandpass'; nf.frequency.value = mtof(m) * 2; ng.gain.value = 0.01 * v; o.connect(g); out(g, bus, 0.5); n.connect(nf); nf.connect(ng); out(ng, bus); o.start(t); o.stop(t + d + 0.3); },
  };

  // ---------------------------------------------------------------- song generator
  // Melody rhythms (2 bars of 16ths). Simple, repeatable and on the beat.
  const MEL_RHYTHMS = {
    pro: ['x...x...x.x.....x...x...x...x...', 'x..x..x.....x...x..x..x...x.....', '..x...x...x.x...x...x...x.......', 'x.....x...x.....x.....x.x.x.....'],
    calm: ['x.......x...x...x.......x.......', 'x.....x.....x...x...........x...', '....x.......x.......x...x.......', 'x...........x...x.......x.......'],
  };
  // Voice a chord near the previous one (smooth movement, no octave jumps).
  function voice(pcs, prev, lo, hi) {
    const cands = [];
    for (let inv = 0; inv < pcs.length; inv++) {
      for (let base = lo - 12; base <= hi; base += 12) {
        const notes = []; let last = -Infinity;
        for (let k = 0; k < pcs.length; k++) { let n = base + pcs[(inv + k) % pcs.length]; while (n <= last) n += 12; notes.push(n); last = n; }
        if (notes[0] >= lo && notes[notes.length - 1] <= hi + 4) cands.push(notes);
      }
    }
    if (!cands.length) return pcs.map((pc) => lo + pc);
    if (!prev) return cands.sort((x, y) => Math.abs(x[0] - (lo + 5)) - Math.abs(y[0] - (lo + 5)))[0];
    const cost = (c) => c.reduce((sum, n, k) => sum + Math.abs(n - (prev[k] != null ? prev[k] : prev[prev.length - 1])), 0);
    return cands.sort((x, y) => cost(x) - cost(y))[0];
  }
  function scaleDegreeNote(root, scale, deg) { const sc = SCALES[scale]; const o = Math.floor(deg / 7); return root + sc[((deg % 7) + 7) % 7] + 12 * o; }

  function makeSong(st) {
    const scale = pick(st.scales), root = pick(st.roots) % 12;
    const tempo = Math.round(rand(st.tempo[0], st.tempo[1]));
    const progA = pick(st.progs), progB = pick(st.progs.filter((p) => p !== progA)) || progA;
    const drums = pick(st.drums), drumsB = Math.random() < 0.5 ? drums : pick(st.drums);
    const bass = pick(st.bass), comp = pick(st.comp.rhythms);
    const calm = st.lead.density < 0.4;
    // Melody: a 2-bar rhythm, and a contour of small steps (scale degrees
    // relative to the chord root). Bars 1-2 state it, bars 3-4 repeat it and
    // land on the root. Same idea all song long, so it's singable, not random.
    const rhythm = pick(MEL_RHYTHMS[calm ? 'calm' : 'pro']);
    const onsets = [...rhythm].map((c, i) => (c === 'x' ? i : -1)).filter((i) => i >= 0);
    let d = pick([0, 2, 4]); const contour = [];
    for (let k = 0; k < onsets.length; k++) {
      if (onsets[k] % 8 === 0) d = [0, 2, 4].reduce((b, x) => (Math.abs(x - d) < Math.abs(b - d) ? x : b), 0); // strong beats: a chord tone
      contour.push(d);
      d += pick([-1, -1, 1, 1, 0, 2, -2]); d = Math.max(-2, Math.min(6, d));
    }
    const answer = contour.slice(); answer[answer.length - 1] = 0; if (answer.length > 1) answer[answer.length - 2] = Math.min(answer[answer.length - 2], 2);
    const plan = [];
    const sec = (n, prog, parts) => { for (let i = 0; i < n; i++) plan.push({ prog, parts, bar: i }); };
    sec(4, progA, { drums: 'light', bass: 0, comp: 1, lead: 0, pad: 1 });
    sec(8, progA, { drums: 'A', bass: 1, comp: 1, lead: 1, pad: 0 });
    sec(8, progB, { drums: 'B', bass: 1, comp: 1, lead: 1, pad: 1 });
    sec(8, progA, { drums: 'A', bass: 1, comp: 1, lead: 1, pad: 1 });
    sec(4, progB, { drums: 'light', bass: 1, comp: 1, lead: 0, pad: 1 });
    sec(8, progB, { drums: 'B', bass: 1, comp: 1, lead: 1, pad: 1 });
    sec(8, progA, { drums: 'A', bass: 1, comp: 1, lead: 1, pad: 1 });
    sec(2, progA, { drums: 'end', bass: 1, comp: 0, lead: 0, pad: 1 });
    tone.bright = rand(0.92, 1.08); tone.detune = rand(5, 8);
    const melBase = (st.lead.octave >= 12 ? 72 : 60) - (calm ? 5 : 0);
    return { scale, root, tempo, progA, progB, drums, drumsB, bass, comp, rhythm, contour, answer, plan, st, prevVoicing: null, curBar: -1, voicing: null, bassNote: 40, melBase,
      keyName: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][root] + ' ' + scale };
  }

  // Groove velocities: accents on the beat, softer off-beats (feels human, stays steady).
  const HAT_VEL = [1, 0.45, 0.7, 0.45, 0.9, 0.45, 0.7, 0.5, 1, 0.45, 0.7, 0.45, 0.9, 0.45, 0.75, 0.55];

  function scheduleStep(t) {
    const s = song, st = s.st, barIdx = Math.floor(step / 16), i = step % 16;
    if (barIdx >= s.plan.length) { // song over: next one (and any pending style switch)
      if (pendingStyle) { styleKey = pendingStyle; style = STYLES[styleKey]; pendingStyle = null; }
      song = makeSong(style); step = 0; songStart = t; return scheduleStep(t);
    }
    const bar = s.plan[barIdx], parts = bar.parts, deg = bar.prog[bar.bar % 4];
    if (s.curBar !== barIdx) {
      s.curBar = barIdx;
      const pcs = chordNotes(s.root, s.scale, deg, st.seventh).map((n) => ((n % 12) + 12) % 12);
      s.voicing = voice(pcs, s.prevVoicing, 55, 67); s.prevVoicing = s.voicing;
      const rootPc = pcs[0]; s.bassNote = 36 + ((rootPc - 36) % 12 + 12) % 12; if (s.bassNote < 38) s.bassNote += 12; // E2..D#3
    }
    const chord = s.voicing;
    const sixteenth = 60 / s.tempo / 4;
    const tt = t + (i % 2 === 1 ? sixteenth * st.swing : 0);
    // Drums: the pattern, steady accents, and a short fill only at the end of each 8-bar phrase.
    const kit = parts.drums === 'B' ? s.drumsB : s.drums;
    const phraseEnd = bar.bar % 8 === 7 && i >= 12;
    if (parts.drums === 'light') { if (i === 0 || i === 8) INST.kick(tt, 0.55); if (i % 4 === 2) (kit.x ? INST.shaker : INST.hat)(tt, 0.5); }
    else if (parts.drums === 'end') { if (i === 0 && bar.bar === 1) { INST.kick(tt, 1); INST.boom(tt, 0.3); } if (bar.bar === 0 && i >= 12) INST.snare(tt, 0.25 + (i - 12) * 0.08); }
    else if (parts.drums) {
      const hit = (p) => p && p[i] === 'x';
      if (hit(kit.k)) INST.kick(tt, 1);
      if (phraseEnd && st.lead.density >= 0.4) INST.snare(tt, 0.3 + (i - 12) * 0.12);
      else { if (hit(kit.s)) INST.snare(tt, 0.85); if (hit(kit.c)) INST.clap(tt, 0.8); }
      if (hit(kit.h)) INST.hat(tt, HAT_VEL[i] * 0.85);
      if (hit(kit.o)) INST.hat(tt, 0.55, null, true);
      if (hit(kit.x)) INST.shaker(tt, HAT_VEL[i]);
      if (hit(kit.t)) INST.tom(tt, 0.55, null, i % 4 === 2 ? 98 : 130);
    }
    // Bass: the chord root, locked to its pattern (octave pop on the last 8th of the bar).
    if (parts.bass && s.bass[i] === 'x') INST[st.bassInst](tt, s.bassNote + (i === 14 && st.lead.density >= 0.4 ? 12 : 0), sixteenth * 1.8, i % 4 === 0 ? 1 : 0.8);
    // Comping: steady rhythm on the smoothly-voiced chord.
    if (parts.comp && s.comp[i] === 'x') {
      if (st.comp.inst === 'arp') INST.arp(tt, chord[(i >> 1) % chord.length] + 12, sixteenth, i % 4 === 0 ? 1 : 0.7);
      else INST[st.comp.inst](tt, chord, sixteenth * (st.comp.inst === 'rhodes' ? 6 : 2.5), 1);
    }
    // Pad: once per bar
    if (st.pad && parts.pad && i === 0) INST[st.pad](tt, chord, sixteenth * 16, 1);
    // Lead: the motif over the current chord (degrees relative to the chord root), answered every other 2 bars.
    if (parts.lead) {
      const pos = (bar.bar % 2) * 16 + i;
      if (s.rhythm[pos] === 'x') {
        const k = [...s.rhythm.slice(0, pos)].filter((c) => c === 'x').length;
        const shape = bar.bar % 4 >= 2 ? s.answer : s.contour;
        let note = scaleDegreeNote(s.root, s.scale, deg + shape[k]);
        // Octave closest to the previous melody note, kept inside the melody's range.
        const ref = s.lastMel != null ? s.lastMel : s.melBase + 5;
        note += 12 * Math.round((ref - note) / 12);
        while (note < s.melBase - 2) note += 12; while (note > s.melBase + 16) note -= 12;
        s.lastMel = note;
        let len = 1; while (len < 6 && pos + len < 32 && s.rhythm[pos + len] !== 'x') len++;
        INST[st.lead.inst](tt, note, sixteenth * len * 0.85, pos % 8 === 0 ? 1 : 0.8);
      }
    }
    if (st.vinyl && i === 0 && bar.bar % 2 === 0) INST.vinyl(tt, sixteenth * 32);
  }

  function tick() {
    if (!running || !ctx) return;
    while (nextStepTime < ctx.currentTime + 0.15) {
      scheduleStep(nextStepTime);
      nextStepTime += 60 / song.tempo / 4;
      step++;
    }
  }

  // ---------------------------------------------------------------- stings
  function duck(seconds) {
    const t = ctx.currentTime;
    duckGain.gain.cancelScheduledValues(t);
    duckGain.gain.setTargetAtTime(0.5, t, 0.08);
    duckGain.gain.setTargetAtTime(1, t + seconds, 0.6);
  }
  function sting(kind) {
    if (!running || !ctx) return;
    const t = ctx.currentTime + 0.03, pro = styleKey.startsWith('pro'), night = styleKey.endsWith('night');
    const root = song ? 60 + song.root : 60, B = sfxBus;
    const chordHit = (notes, at, d) => (pro ? INST.brass : INST.rhodes)(at, notes, d, 0.9, B);
    const notePlay = (m, at, d) => (pro ? INST.softKeys : INST.marimba)(at, m, d * 1.4, pro ? 1.1 : 0.8, B);
    duck({ champIntro: 4, champion: 4.5, jingle: 1.6, replay: 1.4, record: 3.4, breaking: 3.2, upset: 3, final: 3.2, td: 1.6, bad: 1.8, lead: 2, handoff: 2.4, alert: 1.2 }[kind] || 1.5);
    switch (kind) {
      case 'breaking':
        INST.whoosh(t, 0.6, 1, B);
        [0, 0.09, 0.18].forEach((d, i) => chordHit([root + i * 2, root + 4 + i * 2, root + 7 + i * 2], t + 0.55 + d, 0.08));
        chordHit([root + 5, root + 9, root + 12, root + 17], t + 0.85, 1.0);
        INST.boom(t + 0.85, 0.9, B); for (let i = 0; i < 6; i++) INST.snare(t + 0.4 + i * 0.07, 0.25 + i * 0.08, B);
        break;
      case 'upset':
        INST.boom(t, 1, B); chordHit([root - 12, root + 3 - 12, root + 6 - 12], t, 0.5); chordHit([root, root + 3, root + 6, root + 10], t + 0.35, 1.2); INST.tom(t + 0.2, 0.9, B, 80); INST.tom(t + 0.3, 0.9, B, 70);
        break;
      case 'final':
        [0, 4, 7, 12].forEach((iv, i) => notePlay(root + iv, t + i * 0.12, 0.2));
        chordHit([root, root + 4, root + 7, root + 12], t + 0.5, 1.4); INST.kick(t + 0.5, 1, B); INST.hat(t + 0.5, 1, B, true);
        break;
      case 'td':
        [0, 4, 7].forEach((iv, i) => notePlay(root + 12 + iv, t + i * 0.08, 0.12)); INST.clap(t + 0.24, 1, B); chordHit([root + 7, root + 11, root + 14], t + 0.26, 0.4);
        break;
      case 'bad':
        notePlay(root + 7, t, 0.25); notePlay(root + 6, t + 0.28, 0.25); notePlay(root + 5, t + 0.56, 0.6); INST.tom(t + 0.56, 0.6, B, 70);
        break;
      case 'lead':
        INST.whoosh(t, 0.45, 0.8, B); notePlay(root + 7, t + 0.42, 0.15); notePlay(root + 12, t + 0.56, 0.4); INST.kick(t + 0.56, 0.8, B);
        break;
      case 'handoff':
        INST.whoosh(t, 0.7, 0.6, B, false); notePlay(root + 12, t + 0.6, 0.5); notePlay(root + 19, t + 0.75, 0.6);
        break;
      case 'jingle': // commercial break: a little 5-note ditty
        [0, 4, 7, 9, 12].forEach((iv, i) => INST.marimba(t + i * 0.13, root + 12 + iv, 0.2, 1.5, B)); INST.clap(t + 0.65, 0.6, B);
        break;
      case 'replay':
        INST.whoosh(t, 0.5, 0.9, B, false); notePlay(root + 7, t + 0.45, 0.2); notePlay(root, t + 0.62, 0.5);
        break;
      case 'champIntro': // big, slow build: boom, toms, rising brass
        INST.boom(t, 0.9, B); [0, 0.25, 0.5, 0.75].forEach((d, i) => INST.tom(t + 0.4 + d, 0.5 + i * 0.1, B, 90 + i * 12));
        chordHit([root - 12, root - 5, root], t + 1.3, 1.6); chordHit([root - 7, root, root + 4], t + 2.1, 2.2); INST.boom(t + 2.1, 0.8, B);
        break;
      case 'champion': // fanfare for the winner
        INST.boom(t, 1, B);
        [0, 4, 7, 12].forEach((iv, i) => chordHit([root + iv - 12, root + iv - 5, root + iv], t + i * 0.22, 0.25));
        chordHit([root - 12, root - 8, root - 5, root, root + 4], t + 0.95, 2.8); INST.boom(t + 0.95, 0.9, B);
        for (let i = 0; i < 10; i++) INST.snare(t + 0.4 + i * 0.055, 0.2 + i * 0.05, B);
        INST.hat(t + 0.95, 0.8, B, true); INST.hat(t + 1.4, 0.6, B, true);
        break;
      case 'record':
        [0, 4, 7, 12, 16].forEach((iv, i) => notePlay(root + iv, t + i * 0.1, 0.2)); chordHit([root + 12, root + 16, root + 19, root + 24], t + 0.55, 1.6); INST.boom(t + 0.55, 0.8, B); INST.hat(t + 0.55, 1, B, true);
        break;
      default:
        notePlay(root + 12, t, 0.12); notePlay(root + 19, t + 0.1, 0.3);
    }
  }

  // ---------------------------------------------------------------- public
  function start() {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    if (running) return;
    running = true;
    style = STYLES[styleKey];
    song = makeSong(style); step = 0;
    nextStepTime = ctx.currentTime + 0.1; songStart = nextStepTime;
    master.gain.setTargetAtTime(volume, ctx.currentTime, 0.3);
    timer = setInterval(tick, 25);
  }
  function stop() {
    running = false; clearInterval(timer);
    if (ctx) master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.2);
  }
  function setStyle(studio, daypart, champ) {
    const key = champ ? 'champ' : (studio === 'casual' ? 'casual' : 'pro') + '-' + (daypart === 'night' ? 'night' : 'day');
    if (key === styleKey && !pendingStyle) return;
    if (!running) { styleKey = key; style = STYLES[key]; return; }
    // Switch at the next bar: wrap the current song up quickly, then start fresh in the new style.
    pendingStyle = key;
    if (song) { const bar = Math.floor(step / 16); song.plan = song.plan.slice(0, bar + 1); }
  }
  function setVolume(v) { volume = Math.max(0, Math.min(1, v)); if (ctx && running) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.1); }
  function nowPlaying() { return song ? { style: STYLES[styleKey].name, key: song.keyName, tempo: song.tempo } : null; }

  // Recording hook (used to make listening samples): a MediaStream of the final mix.
  function tap() { ensureCtx(); const d = ctx.createMediaStreamDestination(); comp.connect(d); return d.stream; }
  // Test hook: compose a song silently and return its notes (no audio).
  function _dump(key, bars) {
    const saved = {}, log = [];
    for (const k of Object.keys(INST)) { saved[k] = INST[k]; INST[k] = (t, a, d) => log.push({ k, step, n: a }); }
    const keepSong = song, keepStep = step;
    song = makeSong(STYLES[key]); step = 0;
    try { for (let n = 0; n < Math.min(bars, song.plan.length) * 16; n++) { scheduleStep(0); step++; } } finally { Object.assign(INST, saved); }
    const info = { key: song.keyName, scale: song.scale, root: song.root, tempo: song.tempo, log };
    song = keepSong; step = keepStep;
    return info;
  }
  window.DeskMusic = { start, stop, setStyle, sting, setVolume, nowPlaying, tap, _dump, get running() { return running; }, _styles: STYLES };
})();

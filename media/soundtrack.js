/*
 * Rackplanner intro video: the soundtrack.
 *
 * An industrial metal score with a friendly face: drop-D power chords,
 * palm-muted chugs and gallops, big drums and anvil clanks under a bright
 * lead in D major, at 120 BPM. Everything is synthesized with the Web Audio
 * API in an OfflineAudioContext, so there are no samples to license and
 * every run renders the same sound. intro.js passes the score: when the
 * band comes in, where the music stops, and the sound effects, on the same
 * cues as the picture.
 */
(function (root) {
  'use strict';

  const RATE = 48000;
  const BEAT = 0.5; // 120 BPM
  const STEP = BEAT / 4; // a 16th note
  const BAR = BEAT * 4;
  const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  // Per chord: the power chord (MIDI notes), the bass root, a triad for the
  // pad, and the lead's phrase for one bar as [note, beats].
  const CHORDS = {
    D: { power: [38, 45, 50], bass: 38, pad: [62, 66, 69], phrase: [[74, 1], [76, 1], [78, 2]] },
    A: { power: [45, 52, 57], bass: 33, pad: [57, 61, 64], phrase: [[76, 1], [73, 1], [69, 2]] },
    Bm: { power: [47, 54, 59], bass: 35, pad: [59, 62, 66], phrase: [[71, 1], [74, 1], [78, 1.5], [76, 0.5]] },
    G: { power: [43, 50, 55], bass: 31, pad: [55, 59, 62], phrase: [[79, 1], [78, 1], [76, 2]] },
  };

  // Rhythms over the 16 steps of a bar. Guitar hits are a step, or
  // [step, ring in steps] for an open chord; the rest are palm-muted.
  const all16 = Array.from({ length: 16 }, (_, i) => i);
  const GROOVES = {
    drive: {
      guitar: [[0, 3], 2, 4, 6, [8, 2], 10, 12, 14],
      kick: [0, 7, 8, 14],
      snare: [4, 12],
      hat: [0, 2, 4, 6, 8, 10, 12, 14],
    },
    gallop: {
      guitar: [[0, 2], 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15],
      kick: all16,
      snare: [4, 12],
      hat: [0, 4, 8, 12],
    },
    half: {
      guitar: [[0, 7], [8, 4], 12, 13, 14, 15],
      kick: [0, 10],
      snare: [8],
      hat: [0, 2, 4, 6, 8, 10, 12, 14],
    },
    build: { guitar: all16, kick: all16, snare: all16, hat: [] },
  };

  /** Seeded random numbers, so noise is the same on every run. */
  function random(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  }

  /**
   * Renders the soundtrack. `score`: { duration, drop, bars: [[chord,
   * groove]...] from the drop on, lead: [first, last] bar of the melody,
   * stop: [from, to] silence for the band, wipe, final, cues: [{ t, kind,
   * ... }], solo: a part's name to hear only that one, for mixing }.
   * Resolves to an AudioBuffer.
   */
  function render(score) {
    const ctx = new OfflineAudioContext(2, Math.ceil(score.duration * RATE), RATE);
    const rand = random(7);
    const end = score.duration;

    // ---------------------------------------------------------- mixing desk

    const master = ctx.createGain();
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -14;
    glue.knee.value = 6;
    glue.ratio.value = 2;
    glue.attack.value = 0.01;
    glue.release.value = 0.2;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    master.connect(glue).connect(limiter).connect(ctx.destination);
    master.gain.setValueAtTime(1, 0);
    master.gain.setValueAtTime(1, end - 1.4);
    master.gain.linearRampToValueAtTime(0, end);

    // A hall: decaying stereo noise as the impulse response.
    const ir = ctx.createBuffer(2, Math.round(RATE * 2.2), RATE);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = (rand() * 2 - 1) * Math.exp(-i / (RATE * 0.45));
    }
    const reverb = ctx.createConvolver();
    reverb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.7;
    reverb.connect(wet).connect(master);

    /** A part's fader, with a reverb send after it, so a quiet part stays quiet in the hall too. */
    const bus = (name, level) => {
      const g = ctx.createGain();
      g.gain.value = score.solo && score.solo !== name ? 0 : level;
      g.connect(master);
      g.send = ctx.createGain();
      g.send.gain.value = g.gain.value;
      g.send.connect(reverb);
      return g;
    };
    /** Sends `amount` of a sound that plays into `out` to the hall. */
    const toReverb = (node, amount, out) => {
      const g = ctx.createGain();
      g.gain.value = amount;
      node.connect(g).connect(out.send);
    };
    // Levels: drums and guitars up front, the lead just above them, bass
    // underneath, and the pad a quiet bed. Each part peaks near 1 on its own.
    const drums = bus('drums', 0.5);
    const guitars = bus('guitars', 0.2);
    const bassBus = bus('bass', 0.22);
    const padBus = bus('pad', 0.03);
    const leadBus = bus('lead', 0.25);
    const sfx = bus('sfx', 0.6);

    // A dotted-eighth echo for the lead.
    const echo = ctx.createDelay(1);
    echo.delayTime.value = STEP * 3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 2600;
    echo.connect(echoTone).connect(feedback).connect(echo);
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.35;
    echoTone.connect(echoOut).connect(leadBus);
    toReverb(echoOut, 0.5, leadBus);

    // ----------------------------------------------------------- helpers

    const osc = (type, freq, t, stop) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o.start(t);
      o.stop(stop);
      return o;
    };
    const filter = (type, freq, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (q != null) f.Q.value = q;
      return f;
    };
    /** A gain that rises to `v` and dies away with time constant `tau`. */
    const hit = (t, v, tau, attack) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + (attack || 0.002));
      g.gain.setTargetAtTime(0, t + (attack || 0.002), tau);
      return g;
    };
    const noiseBuf = ctx.createBuffer(1, RATE * 2, RATE);
    noiseBuf.getChannelData(0).forEach((_, i, d) => (d[i] = rand() * 2 - 1));
    const noise = (t, stop) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      src.start(t, rand() * 1.8);
      src.stop(stop);
      return src;
    };
    /** A burst of filtered noise. */
    const burst = (t, type, freq, q, v, tau, out, attack) => {
      const g = hit(t, v, tau, attack);
      noise(t, t + tau * 8 + (attack || 0) + 0.05).connect(filter(type, freq, q)).connect(g).connect(out);
      return g;
    };
    const curve = (k) => {
      const c = new Float32Array(2048);
      for (let i = 0; i < c.length; i++) {
        const x = (i / (c.length - 1)) * 2 - 1;
        c[i] = Math.tanh(k * x) / Math.tanh(k);
      }
      return c;
    };

    // ------------------------------------------------------------ drums

    function kick(t, v) {
      const o = osc('sine', 150, t, t + 0.7);
      o.frequency.exponentialRampToValueAtTime(46, t + 0.09);
      o.connect(hit(t, v, 0.11)).connect(drums);
      burst(t, 'highpass', 2500, 0.7, v * 0.25, 0.006, drums);
    }
    function snare(t, v) {
      const tone = osc('triangle', 200, t, t + 0.4);
      tone.frequency.exponentialRampToValueAtTime(165, t + 0.06);
      tone.connect(hit(t, v * 0.5, 0.05)).connect(drums);
      toReverb(burst(t, 'bandpass', 1900, 0.6, v, 0.075, drums), 0.45, drums);
    }
    const hat = (t, v) => burst(t, 'highpass', 8000, 0.7, v, 0.014, drums);
    const crash = (t, v) => toReverb(burst(t, 'highpass', 4500, 0.5, v, 0.55, drums), 0.4, drums);
    function tom(t, f, v) {
      const o = osc('sine', f * 1.7, t, t + 0.8);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.12);
      const g = o.connect(hit(t, v, 0.16));
      g.connect(drums);
      toReverb(g, 0.3, drums);
    }
    /** A cymbal swelling backwards into time `t`. */
    function swell(t, dur, v) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t - dur);
      g.gain.exponentialRampToValueAtTime(v, t - 0.01);
      g.gain.linearRampToValueAtTime(0, t);
      noise(t - dur, t + 0.01).connect(filter('highpass', 5000, 0.5)).connect(g).connect(drums);
      toReverb(g, 0.3, drums);
    }

    // ---------------------------------------------- industrial textures

    /** An anvil: inharmonic partials over a click. */
    function clank(t, f, v, out) {
      const o = out || sfx;
      [[1, 1, 0.16], [2.76, 0.55, 0.09], [5.4, 0.3, 0.05], [8.93, 0.18, 0.03]].forEach(([m, a, tau]) => {
        const g = osc('sine', f * m, t, t + tau * 8 + 0.05).connect(hit(t, v * a, tau, 0.001));
        g.connect(o);
        toReverb(g, 0.2, o);
      });
      burst(t, 'bandpass', 3200, 1.5, v * 0.6, 0.012, o);
    }
    /** The low cinematic brass: detuned saws opening up through a filter, distorted. */
    function braam(t, dur, v) {
      const f = filter('lowpass', 120, 1.5);
      f.frequency.setValueAtTime(120, t);
      f.frequency.exponentialRampToValueAtTime(1500, t + 0.35);
      f.frequency.exponentialRampToValueAtTime(300, t + dur);
      const sh = ctx.createWaveShaper();
      sh.curve = curve(3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + 0.06);
      g.gain.setTargetAtTime(0, t + dur * 0.6, dur * 0.25);
      for (const m of [26, 38, 45, 50]) {
        for (const d of [-9, 9]) {
          const o = osc('sawtooth', hz(m), t, t + dur * 2);
          o.detune.value = d;
          o.connect(f);
        }
      }
      f.connect(sh).connect(g).connect(guitars);
      toReverb(g, 0.35, guitars);
    }
    function riser(t0, t1, v) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(v, t1 - 0.02);
      g.gain.linearRampToValueAtTime(0, t1);
      const f = filter('bandpass', 300, 2);
      f.frequency.setValueAtTime(300, t0);
      f.frequency.exponentialRampToValueAtTime(7000, t1);
      noise(t0, t1 + 0.01).connect(f).connect(g);
      const o = osc('sawtooth', 110, t0, t1 + 0.01);
      o.frequency.exponentialRampToValueAtTime(880, t1);
      const og = ctx.createGain();
      og.gain.value = 0.25;
      o.connect(filter('lowpass', 2000)).connect(og).connect(g);
      g.connect(sfx);
      toReverb(g, 0.3, sfx);
    }
    function whoosh(t, dur, from, to, v) {
      const f = filter('bandpass', from, 1.2);
      f.frequency.setValueAtTime(from, t);
      f.frequency.exponentialRampToValueAtTime(to, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + dur * 0.4);
      g.gain.linearRampToValueAtTime(0, t + dur);
      noise(t, t + dur + 0.01).connect(f).connect(g).connect(sfx);
      toReverb(g, 0.25, sfx);
    }
    function bell(t, f, v, tau) {
      [[1, 1], [2, 0.35], [2.76, 0.25], [5.4, 0.1]].forEach(([m, a]) => {
        const g = osc('sine', f * m, t, t + (tau || 0.6) * 8).connect(hit(t, v * a, (tau || 0.6) / m, 0.002));
        g.connect(sfx);
        toReverb(g, 0.35, sfx);
      });
    }
    function click(t, v) {
      osc('square', 2300, t, t + 0.03).connect(filter('highpass', 1200)).connect(hit(t, v, 0.006, 0.001)).connect(sfx);
    }
    function key(t, v) {
      burst(t, 'highpass', 2500, 0.7, v, 0.008, sfx, 0.001);
      osc('sine', 1600, t, t + 0.05).connect(hit(t, v * 0.4, 0.008, 0.001)).connect(sfx);
    }
    function pop(t, v) {
      const o = osc('sine', 500, t, t + 0.2);
      o.frequency.exponentialRampToValueAtTime(1400, t + 0.05);
      o.connect(hit(t, v, 0.035)).connect(sfx);
    }
    function alarm(t, v) {
      const f = filter('lowpass', 2800, 0.7);
      const g = ctx.createGain();
      g.gain.value = v;
      f.connect(g).connect(sfx);
      toReverb(g, 0.2, sfx);
      [[81, 0], [74, 0.13], [81, 0.26], [74, 0.39]].forEach(([m, d]) => {
        osc('square', hz(m), t + d, t + d + 0.14).connect(hit(t + d, 1, 0.05, 0.004)).connect(f);
      });
    }

    // ------------------------------------------------- the band: guitars

    /** One side of a double-tracked rhythm guitar, played by gating a running power chord. */
    function guitar(pan, detune, lag) {
      const mix = ctx.createGain();
      mix.gain.value = 0.22;
      const voices = [0, 1, 2].map((i) =>
        [detune, -detune - 3].map((d) => {
          const o = osc(i === 0 ? 'sawtooth' : 'square', hz(38), 0, end);
          o.detune.value = d;
          o.connect(mix);
          return o;
        })
      );
      const tone = filter('lowpass', 800, 0.9);
      const drive = ctx.createGain();
      drive.gain.value = 9;
      const sh = ctx.createWaveShaper();
      sh.curve = curve(4);
      sh.oversample = '4x';
      const cab = [filter('highpass', 95, 0.7), filter('peaking', 900, 1), filter('lowpass', 4600, 0.7), filter('lowpass', 6500, 0.5)];
      cab[1].gain.value = -4;
      const gate = ctx.createGain();
      gate.gain.value = 0;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      mix.connect(tone).connect(drive).connect(sh).connect(cab[0]).connect(cab[1]).connect(cab[2]).connect(cab[3]).connect(gate).connect(p).connect(guitars);
      return { voices, tone, gate, lag };
    }
    const sides = [guitar(-0.75, 7, 0), guitar(0.75, -6, 0.008)];

    /** A running bass: saw and sub sine through a low filter, gated like the guitars. */
    const bass = (() => {
      const mix = ctx.createGain();
      mix.gain.value = 0.5;
      const saw = osc('sawtooth', hz(38), 0, end);
      const sub = osc('sine', hz(38), 0, end);
      saw.connect(mix);
      sub.connect(mix);
      const lp = filter('lowpass', 420, 1);
      const sh = ctx.createWaveShaper();
      sh.curve = curve(2);
      const gate = ctx.createGain();
      gate.gain.value = 0;
      mix.connect(lp).connect(sh).connect(gate).connect(bassBus);
      return { voices: [[saw, sub]], gate };
    })();

    // Every hit of the rhythm section, so each gate can be scheduled in order.
    const hits = []; // { t, ring (s), open, v, chord }
    const band = (t) => t >= score.drop - 0.01 && t < score.wipe && !(t >= score.stop[0] && t < score.stop[1]);

    score.bars.forEach(([name, groove], b) => {
      const t0 = score.drop + b * BAR;
      const chord = CHORDS[name];
      for (const s of [...sides, bass]) {
        s.voices.forEach((pair, i) => {
          const m = s === bass ? chord.bass : chord.power[i];
          for (const o of pair) o.frequency.setValueAtTime(hz(m), t0 - 0.004);
        });
      }
      const g = GROOVES[groove];
      for (const h of g.guitar) {
        const [step, ring] = Array.isArray(h) ? h : [h, 0];
        const t = t0 + step * STEP;
        const v = groove === 'build' ? 0.55 + 0.45 * (step / 15) : 1;
        if (band(t)) hits.push({ t, ring: ring * STEP, open: ring > 0, v });
      }
      for (const s of g.kick) if (band(t0 + s * STEP)) kick(t0 + s * STEP, groove === 'gallop' || groove === 'build' ? (s % 4 ? 0.55 : 0.9) : 1);
      for (const s of g.snare) {
        const t = t0 + s * STEP;
        if (band(t)) snare(t, groove === 'build' ? 0.25 + 0.6 * (s / 15) : 0.8);
      }
      for (const s of g.hat) if (band(t0 + s * STEP)) hat(t0 + s * STEP, s % 4 ? 0.12 : 0.2);
      // The pad: a soft major triad under the distortion, the friendly part.
      if (t0 < score.wipe) pad(t0, Math.min(BAR, score.wipe - t0), chord.pad, 1, t0 < score.stop[1] && t0 + BAR > score.stop[0]);
    });

    function gateHits(list, s, muteHz, openHz) {
      list.forEach((h, i) => {
        const t = h.t + (s.lag || 0);
        const next = list[i + 1] ? list[i + 1].t + (s.lag || 0) : Infinity;
        const g = s.gate.gain;
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(h.v, t + 0.003);
        const hold = h.open ? h.ring * 0.7 : 0.03;
        const tau = h.open ? h.ring * 0.3 + 0.02 : 0.03;
        g.setTargetAtTime(0, t + 0.003 + hold, tau);
        if (Number.isFinite(next) && next - 0.012 > t + 0.003 + hold) g.setTargetAtTime(0, next - 0.012, 0.003);
        if (s.tone) {
          s.tone.frequency.setValueAtTime(h.open ? openHz : muteHz, t);
          if (h.open) s.tone.frequency.exponentialRampToValueAtTime(openHz * 0.55, t + h.ring + 0.01);
        }
      });
    }

    // ------------------------------------------------- pad, lead, intro

    function pad(t, dur, notes, v, ducked) {
      const f = filter('lowpass', 900, 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + 0.12);
      g.gain.setValueAtTime(v, t + dur - 0.15);
      g.gain.linearRampToValueAtTime(0, t + dur + 0.25);
      if (ducked) {
        // The music drops out while the alarm sounds.
        g.gain.cancelScheduledValues(score.stop[0]);
        g.gain.setTargetAtTime(0, score.stop[0], 0.02);
      }
      for (const m of notes) {
        for (const d of [-10, 10]) {
          const o = osc('sawtooth', hz(m), t, t + dur + 1);
          o.detune.value = d;
          o.connect(f);
        }
      }
      f.connect(g).connect(padBus);
      toReverb(g, 0.4, padBus);
    }

    /** The lead: a bright, slightly driven synth singing the melody over the chords. */
    function lead(notes) {
      const a = osc('sawtooth', hz(notes[0].m), 0, end);
      const b = osc('sawtooth', hz(notes[0].m), 0, end);
      b.detune.value = 9;
      const lfo = osc('sine', 5.5, 0, end);
      const depth = ctx.createGain();
      depth.gain.value = 8;
      lfo.connect(depth);
      depth.connect(a.detune);
      depth.connect(b.detune);
      const f = filter('lowpass', 3200, 0.8);
      const sh = ctx.createWaveShaper();
      sh.curve = curve(1.6);
      const g = ctx.createGain();
      g.gain.value = 0;
      a.connect(f);
      b.connect(f);
      f.connect(sh).connect(g);
      g.connect(leadBus);
      g.connect(echo);
      toReverb(g, 0.3, leadBus);
      for (const n of notes) {
        for (const o of [a, b]) o.frequency.setTargetAtTime(hz(n.m), n.t, 0.012);
        g.gain.setTargetAtTime(n.v, n.t, 0.01);
        g.gain.setTargetAtTime(n.v * 0.7, n.t + 0.08, 0.1);
        g.gain.setTargetAtTime(0, n.t + n.d - 0.04, 0.03);
      }
    }

    const melody = [];
    for (let b = score.lead[0]; b <= score.lead[1]; b++) {
      let t = score.drop + b * BAR;
      for (const [m, beats] of CHORDS[score.bars[b][0]].phrase) {
        const d = beats * BEAT;
        if (t + d <= score.wipe) melody.push({ t, m, d, v: 0.6 });
        t += d;
      }
    }

    // Intro: a low drone and a friendly chord swell, metal ticking, a snare roll and a riser into the drop.
    (() => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(0.5, 1.2);
      g.gain.linearRampToValueAtTime(0.7, score.drop - 0.05);
      g.gain.linearRampToValueAtTime(0, score.drop);
      const f = filter('lowpass', 90, 1);
      f.frequency.setValueAtTime(90, 0);
      f.frequency.exponentialRampToValueAtTime(700, score.drop);
      for (const m of [26, 38]) osc('sawtooth', hz(m), 0, score.drop + 0.05).connect(f);
      f.connect(g).connect(bassBus);
    })();
    pad(0.05, score.drop - 0.2, CHORDS.D.pad, 0.7);
    for (let t = 0.5; t < score.drop - 0.01; t += BEAT / 2) clank(t, 520, t % BEAT ? 0.06 : 0.12);
    for (let t = 1.5; t < score.drop - 0.01; t += STEP) snare(t, 0.12 + 0.5 * ((t - 1.5) / (score.drop - 1.5)));
    riser(1.2, score.drop, 0.5);
    kick(score.drop, 1);
    crash(score.drop, 0.7);
    braam(score.drop, 1.6, 0.35);

    // The alarm: the band stops, then toms and a swelling cymbal bring it back.
    braam(score.stop[0], 0.6, 0.3);
    crash(score.stop[0], 0.4);
    swell(score.stop[1], 0.5, 0.35);
    [[0.25, 160], [0.19, 130], [0.125, 110], [0.06, 90]].forEach(([d, f]) => tom(score.stop[1] - d, f, 0.7));
    crash(score.stop[1], 0.6);
    for (const t of [6.5, 14.5, 18.5]) crash(score.drop + Math.round((t - score.drop) / BAR) * BAR, 0.45);

    // The wipe and the closing hit: a big D major, held while the link types out.
    whoosh(score.wipe, score.final - score.wipe + 0.1, 400, 5000, 0.4);
    swell(score.final, score.final - score.wipe, 0.4);
    const F = score.final;
    for (const s of [...sides, bass]) {
      s.voices.forEach((pair, i) => {
        const m = s === bass ? CHORDS.D.bass : CHORDS.D.power[i];
        for (const o of pair) o.frequency.setValueAtTime(hz(m), F - 0.004);
      });
    }
    hits.push({ t: F, ring: 2.6, open: true, v: 1 });
    kick(F, 1);
    crash(F, 0.8);
    braam(F, 2.2, 0.35);
    pad(F, 2.4, [62, 66, 69, 74], 1.1);
    for (const [m, d] of [[86, 0.02], [90, 0.06], [93, 0.1]]) bell(F + d, hz(m), 0.1, 1);
    melody.push({ t: F, m: 74, d: 2.4, v: 0.55 });

    gateHits(hits, sides[0], 650, 3400);
    gateHits(hits, sides[1], 650, 3400);
    gateHits(hits, bass, 0, 0);
    lead(melody);

    // ------------------------------------------- effects on the picture's cues

    for (const c of score.cues) {
      switch (c.kind) {
        case 'land': // a device seated in its rack: a clank, deeper for heavy ones
          if (c.heavy) {
            clank(c.t, 300, 0.32);
            tom(c.t, 70, 0.4);
          } else clank(c.t, [660, 740, 880][c.rack % 3], 0.14);
          break;
        case 'over':
          alarm(c.t, 0.32);
          clank(c.t, 240, 0.4);
          break;
        case 'spot':
          bell(c.t, hz([78, 81, 83, 86][c.i % 4]), 0.18, 0.7);
          break;
        case 'swish':
          whoosh(c.t, 0.35, 900, 3500, 0.12);
          break;
        case 'paper':
          whoosh(c.t, 0.45, 2500, 900, 0.2);
          break;
        case 'click':
          click(c.t, 0.16);
          break;
        case 'key':
          key(c.t, c.soft ? 0.1 : 0.18);
          break;
        case 'pop':
          pop(c.t, 0.12);
          break;
        case 'count':
          clank(c.t, 900 + c.i * 60, 0.06);
          break;
        case 'ding':
          bell(c.t, hz(86), 0.2, 0.8);
          bell(c.t + 0.09, hz(90), 0.2, 0.9);
          break;
      }
    }

    return ctx.startRendering();
  }

  /**
   * 16-bit PCM WAV of an AudioBuffer, at an RMS level of -16 dBFS (about
   * -14 LUFS for this mix, the usual level for video on the web), with peaks
   * kept below -1 dBFS.
   */
  function wav(buffer) {
    const channels = [0, 1].map((c) => buffer.getChannelData(c));
    let peak = 0;
    let sum = 0;
    for (const d of channels) {
      for (let i = 0; i < d.length; i++) {
        peak = Math.max(peak, Math.abs(d[i]));
        sum += d[i] * d[i];
      }
    }
    const rms = Math.sqrt(sum / (2 * buffer.length));
    const scale = peak > 0 ? Math.min(0.891 / peak, Math.pow(10, -16 / 20) / rms) : 1;
    const n = buffer.length;
    const out = new DataView(new ArrayBuffer(44 + n * 4));
    const text = (o, s) => [...s].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
    text(0, 'RIFF');
    out.setUint32(4, 36 + n * 4, true);
    text(8, 'WAVEfmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 2, true);
    out.setUint32(24, buffer.sampleRate, true);
    out.setUint32(28, buffer.sampleRate * 4, true);
    out.setUint16(32, 4, true);
    out.setUint16(34, 16, true);
    text(36, 'data');
    out.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i] * scale));
        out.setInt16(44 + i * 4 + c * 2, Math.round(s * 32767), true);
      }
    }
    return new Uint8Array(out.buffer);
  }

  (root.RP = root.RP || {}).soundtrack = { render, wav };
})(typeof globalThis !== 'undefined' ? globalThis : this);

import { AttackType, SongTrackMode } from '../types/game';

const TOTAL_STEPS = 128; // 8-bar evolving rap arrangement per track

const NOTE_FREQ: Record<string, number> = {
  E1: 41.2,
  F1: 43.65,
  G1: 49.0,
  Ab1: 51.91,
  A1: 55.0,
  Bb1: 58.27,
  B1: 61.74,
  C2: 65.41,
  Db2: 69.3,
  D2: 73.42,
  Eb2: 77.78,
  E2: 82.41,
  F2: 87.31,
  G2: 98.0,
  Ab2: 103.83,
  A2: 110.0,
  Bb2: 116.54,
  B2: 123.47,
  C3: 130.81,
  D3: 146.83,
  Eb3: 155.56,
  E3: 164.81,
  F3: 174.61,
  G3: 196.0,
  Ab3: 207.65,
  A3: 220.0,
  Bb3: 233.08,
  C4: 261.63,
  D4: 293.66,
  Eb4: 311.13,
  E4: 329.63,
  F4: 349.23,
  G4: 392.0,
  Ab4: 415.3,
  A4: 440.0,
  Bb4: 466.16,
  C5: 523.25,
  D5: 587.33,
  Eb5: 622.25,
  F5: 698.46,
};

// Track 1 ("Championship Cypher" - 94 BPM Boom-Bap Rap in C minor)
const T1_STEP_SEC = 60 / 94 / 4; // ~0.1596s
const T1_BASS_BY_BAR = ['C2', 'C2', 'Ab1', 'G1', 'C2', 'Eb2', 'Ab1', 'G1'];
const T1_CHORDS_BY_BAR = [
  ['C3', 'Eb3', 'G3', 'Bb3'],
  ['C3', 'Eb3', 'G3', 'Bb3'],
  ['Ab2', 'C3', 'Eb3', 'G3'],
  ['G2', 'B2', 'D3', 'F3'],
  ['C3', 'Eb3', 'G3', 'Bb3'],
  ['Eb3', 'G3', 'Bb3', 'D4'],
  ['Ab2', 'C3', 'Eb3', 'G3'],
  ['G2', 'D3', 'F3', 'B3'],
];
const T1_LEAD_BAR_A: (string | null)[] = [
  'C5', null, 'Eb5', null, null, 'D5', 'C5', null,
  'Bb4', null, 'C5', null, 'G4', null, null, null,
];
const T1_LEAD_BAR_B: (string | null)[] = [
  'Eb5', null, 'D5', 'C5', null, 'Bb4', 'G4', null,
  'Ab4', null, 'G4', null, 'F4', 'G4', null, null,
];

// Track 2 ("Heavyweight Trap" - 134 BPM Half-Time Trap Rap in F minor)
const T2_STEP_SEC = 60 / 134 / 4; // ~0.1119s
const T2_BASS_BY_BAR = ['F1', 'F1', 'Db2', 'C2', 'F1', 'Ab1', 'Db2', 'C2'];
const T2_CHORDS_BY_BAR = [
  ['F3', 'Ab3', 'C4'],
  ['F3', 'Ab3', 'C4'],
  ['Db3', 'F3', 'Ab3'],
  ['C3', 'E3', 'G3'],
  ['F3', 'Ab3', 'C4'],
  ['Ab3', 'C4', 'Eb4'],
  ['Db3', 'F3', 'Ab3'],
  ['C3', 'G3', 'Bb3'],
];
const T2_FLUTE_BAR_A: (string | null)[] = [
  'F5', null, null, 'Eb5', null, null, 'C5', null,
  'Ab4', null, 'Bb4', null, 'C5', null, null, null,
];
const T2_FLUTE_BAR_B: (string | null)[] = [
  'Db5', null, 'C5', null, 'Ab4', null, 'G4', null,
  'F4', null, 'Ab4', 'C5', 'Eb5', null, 'C5', null,
];

const FEATURED_TRACK_URL =
  '/assets/aistudio/Sucker_for_Pain__with_Logic__Ty_Dolla__ign___X_Ambassadors___MpQ-Xd_1KWQ___1__b2c9c5c7.mp3';

type ActiveTrackId = 'sucker_for_pain' | 'track1' | 'track2';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;

  // Uploaded MP3 soundtrack pipeline
  private bgmAudio: HTMLAudioElement | null = null;
  private bgmSource: MediaElementAudioSourceNode | null = null;
  private bgmFilter: BiquadFilterNode | null = null;
  private bgmGain: GainNode | null = null;
  private bgmUsesDirectVolume = false;

  public muted = false;
  public songVolume = 0.65; // 0..1
  public sfxVolume = 0.85; // 0..1
  public songTrackMode: SongTrackMode = 'sucker_for_pain';
  public inBattle = false;

  // Song scheduler state
  private songPlaying = false;
  private schedulerId: number | null = null;
  private nextStepTime = 0;
  private currentStep = 0;
  private activeAutoTrack: ActiveTrackId = 'sucker_for_pain';
  private cyclesOnCurrentTrack = 0;

  private ensureContext(allowWhenMuted = false): AudioContext | null {
    if (this.muted && !allowWhenMuted) return null;
    if (typeof window === 'undefined') return null;

    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.connect(this.ctx.destination);

      this.musicFilter = this.ctx.createBiquadFilter();
      this.musicFilter.type = 'lowpass';
      this.musicFilter.frequency.value = this.inBattle ? 1900 : 7200;
      this.musicFilter.Q.value = 0.55;

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = this.computeMusicGainTarget();
      this.musicFilter.connect(this.musicGain);
      this.musicGain.connect(this.ctx.destination);

      this.syncMasterGains(true);
    }

    if (this.ctx.state === 'suspended' && !this.muted) {
      void this.ctx.resume();
    }

    if (!this.noiseBuffer && this.ctx) {
      const sampleRate = this.ctx.sampleRate;
      const length = Math.floor(sampleRate * 1.2);
      const buffer = this.ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
    }

    return this.ctx;
  }

  private ensureBgmAudio() {
    if (typeof window === 'undefined' || !this.ctx) return;

    if (!this.bgmAudio) {
      const audio = new Audio(FEATURED_TRACK_URL);
      audio.preload = 'auto';
      audio.loop = this.songTrackMode !== 'auto';
      audio.addEventListener('ended', () => {
        if (this.songTrackMode === 'auto') {
          this.activeAutoTrack = 'track1';
          this.currentStep = 0;
          this.cyclesOnCurrentTrack = 0;
          this.nextStepTime = (this.ctx?.currentTime ?? 0) + 0.05;
        }
      });
      this.bgmAudio = audio;
    }

    if (!this.bgmGain && !this.bgmUsesDirectVolume) {
      try {
        this.bgmFilter = this.ctx.createBiquadFilter();
        this.bgmFilter.type = 'lowpass';
        this.bgmFilter.frequency.value = this.inBattle ? 2600 : 18000;
        this.bgmFilter.Q.value = 0.5;

        this.bgmGain = this.ctx.createGain();
        this.bgmGain.gain.value = this.computeBgmGainTarget();

        this.bgmSource = this.ctx.createMediaElementSource(this.bgmAudio);
        this.bgmSource.connect(this.bgmFilter);
        this.bgmFilter.connect(this.bgmGain);
        this.bgmGain.connect(this.ctx.destination);
      } catch {
        this.bgmUsesDirectVolume = true;
        this.bgmAudio.volume = this.computeBgmGainTarget();
      }
    }
  }

  private computeMusicGainTarget(): number {
    if (this.muted || this.songVolume <= 0.001) return 0;
    // Battle ducking: song stays strictly softer in battles than in menus
    const modeScale = this.inBattle ? 0.14 : 0.4;
    return this.songVolume * modeScale;
  }

  private computeBgmGainTarget(): number {
    if (this.muted || this.songVolume <= 0.001) return 0;
    // Mastered MP3 ducking: crisp in menus, strictly soft during active fights so punches & bell cut through
    const modeScale = this.inBattle ? 0.14 : 0.44;
    return Math.min(1, this.songVolume * modeScale);
  }

  private syncMasterGains(immediate = false) {
    if (!this.ctx || !this.sfxGain || !this.musicGain || !this.musicFilter) return;
    const now = this.ctx.currentTime;

    const sfxTarget = this.muted ? 0 : this.sfxVolume;
    const musicTarget = this.computeMusicGainTarget();
    const filterTarget = this.inBattle ? 1900 : 7200;
    const bgmTarget = this.computeBgmGainTarget();
    const bgmFilterTarget = this.inBattle ? 2600 : 18000;

    if (immediate) {
      this.sfxGain.gain.setValueAtTime(sfxTarget, now);
      this.musicGain.gain.setValueAtTime(musicTarget, now);
      this.musicFilter.frequency.setValueAtTime(filterTarget, now);
      if (this.bgmGain && this.bgmFilter) {
        this.bgmGain.gain.setValueAtTime(bgmTarget, now);
        this.bgmFilter.frequency.setValueAtTime(bgmFilterTarget, now);
      }
    } else {
      this.sfxGain.gain.setTargetAtTime(sfxTarget, now, 0.04);
      this.musicGain.gain.setTargetAtTime(musicTarget, now, 0.22);
      this.musicFilter.frequency.setTargetAtTime(filterTarget, now, 0.25);
      if (this.bgmGain && this.bgmFilter) {
        this.bgmGain.gain.setTargetAtTime(bgmTarget, now, 0.22);
        this.bgmFilter.frequency.setTargetAtTime(bgmFilterTarget, now, 0.25);
      }
    }

    if (this.bgmAudio && this.bgmUsesDirectVolume) {
      this.bgmAudio.volume = bgmTarget;
    }

    if (this.songPlaying) {
      this.syncBgmPlaybackState();
    }
  }

  private syncBgmPlaybackState() {
    if (!this.bgmAudio) return;
    const track = this.getCurrentTrackId();
    const shouldPlayMp3 =
      this.songPlaying &&
      track === 'sucker_for_pain' &&
      !this.muted &&
      this.songVolume > 0.001;

    this.bgmAudio.loop = this.songTrackMode === 'sucker_for_pain';

    if (shouldPlayMp3) {
      if (this.bgmAudio.paused) {
        void this.bgmAudio.play().catch(() => {
          // Ignore autoplay restriction until next user interaction
        });
      }
    } else if (!this.bgmAudio.paused) {
      this.bgmAudio.pause();
    }
  }

  public unlock() {
    const ctx = this.ensureContext(true);
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume();
    }
    this.startSong();
    this.syncBgmPlaybackState();
  }

  public setMuted(muted: boolean) {
    this.muted = muted;
    this.syncMasterGains(false);
    if (!muted && this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  public setSongVolume(volume01: number) {
    this.songVolume = Math.max(0, Math.min(1, volume01));
    this.syncMasterGains(false);
  }

  public setSfxVolume(volume01: number) {
    this.sfxVolume = Math.max(0, Math.min(1, volume01));
    this.syncMasterGains(false);
  }

  public setSongTrack(mode: SongTrackMode) {
    if (this.songTrackMode === mode) return;
    this.songTrackMode = mode;
    if (mode === 'sucker_for_pain' || mode === 'track1' || mode === 'track2') {
      this.activeAutoTrack = mode;
    } else {
      this.activeAutoTrack = 'sucker_for_pain';
    }
    this.currentStep = 0;
    this.cyclesOnCurrentTrack = 0;
    if (this.ctx) {
      this.nextStepTime = this.ctx.currentTime + 0.06;
    }
    if (this.bgmAudio && mode === 'sucker_for_pain') {
      this.bgmAudio.currentTime = 0;
    }
    this.syncBgmPlaybackState();
  }

  public setInBattle(inBattle: boolean) {
    if (this.inBattle === inBattle) return;
    this.inBattle = inBattle;
    this.syncMasterGains(false);
  }

  public startSong() {
    if (this.songPlaying) {
      this.syncBgmPlaybackState();
      return;
    }
    const ctx = this.ensureContext(true);
    if (!ctx) return;

    this.ensureBgmAudio();
    this.songPlaying = true;
    this.nextStepTime = ctx.currentTime + 0.06;
    this.syncBgmPlaybackState();

    this.schedulerId = window.setInterval(() => {
      this.scheduleSongSteps();
    }, 65);
  }

  public stopSong() {
    this.songPlaying = false;
    if (this.schedulerId !== null) {
      window.clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
    if (this.bgmAudio && !this.bgmAudio.paused) {
      this.bgmAudio.pause();
    }
  }

  private getCurrentTrackId(): ActiveTrackId {
    if (
      this.songTrackMode === 'sucker_for_pain' ||
      this.songTrackMode === 'track1' ||
      this.songTrackMode === 'track2'
    ) {
      return this.songTrackMode;
    }
    return this.activeAutoTrack;
  }

  private scheduleSongSteps() {
    if (!this.songPlaying || !this.ctx || !this.musicFilter) return;
    if (this.ctx.state !== 'running') return;

    const track = this.getCurrentTrackId();
    if (track === 'sucker_for_pain') {
      this.syncBgmPlaybackState();
      this.nextStepTime = this.ctx.currentTime + 0.08;
      return;
    }

    const stepDur = track === 'track1' ? T1_STEP_SEC : T2_STEP_SEC;

    if (this.muted || this.songVolume <= 0.001) {
      while (this.nextStepTime < this.ctx.currentTime + 0.22) {
        this.nextStepTime += stepDur;
        this.advanceStep();
      }
      return;
    }

    while (this.nextStepTime < this.ctx.currentTime + 0.24) {
      const currentTrack = this.getCurrentTrackId();
      if (currentTrack === 'sucker_for_pain') break;
      const dt = currentTrack === 'track1' ? T1_STEP_SEC : T2_STEP_SEC;
      if (currentTrack === 'track1') {
        this.triggerBoomBapRapStep(this.currentStep, this.nextStepTime);
      } else {
        this.triggerTrapRapStep(this.currentStep, this.nextStepTime);
      }
      this.nextStepTime += dt;
      this.advanceStep();
    }
  }

  private advanceStep() {
    this.currentStep += 1;
    if (this.currentStep >= TOTAL_STEPS) {
      this.currentStep = 0;
      this.cyclesOnCurrentTrack += 1;
      // In auto mode, rotate cleanly across tracks every 2 full 8-bar cycles
      if (this.songTrackMode === 'auto' && this.cyclesOnCurrentTrack >= 2) {
        this.cyclesOnCurrentTrack = 0;
        if (this.activeAutoTrack === 'track1') {
          this.activeAutoTrack = 'track2';
        } else {
          this.activeAutoTrack = 'sucker_for_pain';
          if (this.bgmAudio) this.bgmAudio.currentTime = 0;
          this.syncBgmPlaybackState();
        }
      }
    }
  }

  // Rap Formant Synth Chop ("UH" / "YEAH" / "AY" rhythmic vocal-style cadence accent)
  private triggerRapCadenceChop(
    time: number,
    freq: number,
    formantHz: number,
    dur: number,
    gainLevel: number,
  ) {
    if (!this.ctx || !this.musicFilter) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, time);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.88, time + dur);

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(formantHz, time);
    bp.frequency.linearRampToValueAtTime(formantHz * 0.72, time + dur);
    bp.Q.value = 3.2;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, time);
    g.gain.linearRampToValueAtTime(gainLevel, time + 0.014);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);

    osc.connect(bp);
    bp.connect(g);
    g.connect(this.musicFilter);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  }

  // TRACK 1: Boom-Bap East-Coast Rap Beat (94 BPM, 8-bar evolving structure)
  private triggerBoomBapRapStep(step: number, time: number) {
    if (!this.ctx || !this.musicFilter) return;
    const bar = Math.floor(step / 16); // 0..7
    const s = step % 16;
    const isHook = bar === 4 || bar === 5;
    const isBreak = bar === 6;
    const isTurnaround = bar === 7;
    // Boom-bap swing delay on odd 16ths
    const swungTime = time + (s % 2 === 1 ? 0.016 : 0);

    // 1. Punchy Rap Kick
    const kickHits = isBreak
      ? [0, 10]
      : isHook
        ? [0, 3, 6, 8, 10, 14]
        : [0, 3, 8, 10, 15];
    if (kickHits.includes(s)) {
      const kick = this.ctx.createOscillator();
      kick.type = 'sine';
      kick.frequency.setValueAtTime(132, swungTime);
      kick.frequency.exponentialRampToValueAtTime(42, swungTime + 0.14);
      const kg = this.ctx.createGain();
      kg.gain.setValueAtTime(s === 0 ? 0.56 : 0.44, swungTime);
      kg.gain.exponentialRampToValueAtTime(0.001, swungTime + 0.22);
      kick.connect(kg);
      kg.connect(this.musicFilter);
      kick.start(swungTime);
      kick.stop(swungTime + 0.24);
    }

    // 2. Crisp Boom-Bap Snare + Clap Layer (beats 2 & 4 + turnaround fill)
    const snareHit = s === 4 || s === 12 || (isTurnaround && (s === 14 || s === 15));
    if (snareHit && this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1950, swungTime);
      bp.Q.value = 0.85;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(s === 4 || s === 12 ? 0.28 : 0.16, swungTime);
      ng.gain.exponentialRampToValueAtTime(0.001, swungTime + 0.14);
      noise.connect(bp);
      bp.connect(ng);
      ng.connect(this.musicFilter);
      noise.start(swungTime);
      noise.stop(swungTime + 0.15);

      const body = this.ctx.createOscillator();
      body.type = 'triangle';
      body.frequency.setValueAtTime(195, swungTime);
      body.frequency.exponentialRampToValueAtTime(105, swungTime + 0.08);
      const bg = this.ctx.createGain();
      bg.gain.setValueAtTime(0.18, swungTime);
      bg.gain.exponentialRampToValueAtTime(0.001, swungTime + 0.09);
      body.connect(bg);
      bg.connect(this.musicFilter);
      body.start(swungTime);
      body.stop(swungTime + 0.1);
    }

    // 3. Swinging Hi-Hats & Open Hat on offbeats
    if (!isBreak && (s % 2 === 0 || (bar >= 2 && s === 7)) && this.noiseBuffer) {
      const isOpen = s === 14 && (bar % 2 === 1);
      const hat = this.ctx.createBufferSource();
      hat.buffer = this.noiseBuffer;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(6800, swungTime);
      const hg = this.ctx.createGain();
      hg.gain.setValueAtTime(isOpen ? 0.09 : s % 4 === 2 ? 0.075 : 0.04, swungTime);
      hg.gain.exponentialRampToValueAtTime(0.001, swungTime + (isOpen ? 0.18 : 0.045));
      hat.connect(hp);
      hp.connect(hg);
      hg.connect(this.musicFilter);
      hat.start(swungTime);
      hat.stop(swungTime + (isOpen ? 0.19 : 0.05));
    }

    // 4. Deep Funky Rap Sub-Bass
    if (s === 0 || s === 6 || s === 10 || (isHook && s === 14)) {
      const rootFreq = NOTE_FREQ[T1_BASS_BY_BAR[bar]] ?? 65.41;
      const freq = s === 14 ? rootFreq * 1.189 : rootFreq;
      const bass = this.ctx.createOscillator();
      bass.type = 'triangle';
      bass.frequency.setValueAtTime(freq, swungTime);
      const dur = s === 0 ? T1_STEP_SEC * 5.2 : T1_STEP_SEC * 3.0;
      const bg = this.ctx.createGain();
      bg.gain.setValueAtTime(0.001, swungTime);
      bg.gain.linearRampToValueAtTime(0.36, swungTime + 0.018);
      bg.gain.exponentialRampToValueAtTime(0.001, swungTime + dur);
      bass.connect(bg);
      bg.connect(this.musicFilter);
      bass.start(swungTime);
      bass.stop(swungTime + dur + 0.02);
    }

    // 5. Soulful Hip-Hop Piano / Brass Chops (varied rhythm across bars)
    const chordHits = isHook ? [0, 3, 6, 10] : [0, 6, 11];
    if (chordHits.includes(s)) {
      const chord = T1_CHORDS_BY_BAR[bar];
      const dur = s === 0 ? T1_STEP_SEC * 4.5 : T1_STEP_SEC * 2.4;
      for (const note of chord) {
        const f = NOTE_FREQ[note];
        if (!f) continue;
        const osc = this.ctx.createOscillator();
        osc.type = isHook ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(f, swungTime);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(isHook ? 2100 : 1450, swungTime);
        lp.frequency.exponentialRampToValueAtTime(480, swungTime + dur);
        const cg = this.ctx.createGain();
        cg.gain.setValueAtTime(0.001, swungTime);
        cg.gain.linearRampToValueAtTime(isHook ? 0.065 : 0.055, swungTime + 0.015);
        cg.gain.exponentialRampToValueAtTime(0.001, swungTime + dur);
        osc.connect(lp);
        lp.connect(cg);
        cg.connect(this.musicFilter);
        osc.start(swungTime);
        osc.stop(swungTime + dur + 0.02);
      }
    }

    // 6. Rapper Cadence Vocal-Formant Chops & Hook Melody
    if (bar >= 2 && !isBreak) {
      const cadenceSteps = isHook ? [2, 5, 8, 11, 14] : [2, 7, 10, 14];
      if (cadenceSteps.includes(s)) {
        const pitch = s === 8 ? 196 : s === 14 ? 233 : 165;
        const formant = s % 4 === 2 ? 920 : 1280;
        this.triggerRapCadenceChop(swungTime, pitch, formant, 0.13, isHook ? 0.11 : 0.08);
      }
    }

    if (bar >= 4 && !isBreak) {
      const leadArr = bar % 2 === 0 ? T1_LEAD_BAR_A : T1_LEAD_BAR_B;
      const note = leadArr[s];
      if (note && NOTE_FREQ[note]) {
        const lead = this.ctx.createOscillator();
        lead.type = 'triangle';
        lead.frequency.setValueAtTime(NOTE_FREQ[note], swungTime);
        const lg = this.ctx.createGain();
        lg.gain.setValueAtTime(0.001, swungTime);
        lg.gain.linearRampToValueAtTime(0.1, swungTime + 0.015);
        lg.gain.exponentialRampToValueAtTime(0.001, swungTime + T1_STEP_SEC * 2.2);
        lead.connect(lg);
        lg.connect(this.musicFilter);
        lead.start(swungTime);
        lead.stop(swungTime + T1_STEP_SEC * 2.3);
      }
    }
  }

  // TRACK 2: Heavyweight Trap Rap Beat (134 BPM half-time, 8-bar evolving structure)
  private triggerTrapRapStep(step: number, time: number) {
    if (!this.ctx || !this.musicFilter) return;
    const bar = Math.floor(step / 16); // 0..7
    const s = step % 16;
    const isHook = bar === 4 || bar === 5;
    const isBreak = bar === 6;
    const isTurnaround = bar === 7;

    // 1. Heavy Sliding 808 Sub + Kick (syncopated trap bounce)
    const eightOhEightHits = isBreak
      ? [0, 12]
      : isHook
        ? [0, 3, 6, 10, 13, 15]
        : [0, 6, 10, 14];
    if (eightOhEightHits.includes(s)) {
      const bassFreq = NOTE_FREQ[T2_BASS_BY_BAR[bar]] ?? 43.65;
      const sub = this.ctx.createOscillator();
      sub.type = 'sine';
      const slideUp = isHook && s === 15;
      sub.frequency.setValueAtTime(bassFreq * 2.2, time);
      sub.frequency.exponentialRampToValueAtTime(
        slideUp ? bassFreq * 1.5 : bassFreq,
        time + 0.07,
      );
      const dur = s === 0 ? T2_STEP_SEC * 5.8 : T2_STEP_SEC * 3.4;
      const sg = this.ctx.createGain();
      sg.gain.setValueAtTime(0.55, time);
      sg.gain.exponentialRampToValueAtTime(0.001, time + dur);
      sub.connect(sg);
      sg.connect(this.musicFilter);
      sub.start(time);
      sub.stop(time + dur + 0.03);
    }

    // 2. Half-Time Crisp Trap Snare / Clap (beat 3 = step 8 + ghost notes)
    if ((s === 8 || (isTurnaround && s >= 12)) && this.noiseBuffer) {
      const clap = this.ctx.createBufferSource();
      clap.buffer = this.noiseBuffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2200, time);
      bp.Q.value = 0.75;
      const cg = this.ctx.createGain();
      cg.gain.setValueAtTime(s === 8 ? 0.32 : 0.17, time);
      cg.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
      clap.connect(bp);
      bp.connect(cg);
      cg.connect(this.musicFilter);
      clap.start(time);
      clap.stop(time + 0.15);
    }

    // 3. Rolling Trap Hi-Hats (rapid double-burst triplet rolls on bars 1,3,5,7)
    if (!isBreak && this.noiseBuffer) {
      const isRoll = (s === 6 || s === 14) && (bar % 2 === 1 || isHook);
      const playsHat = s % 2 === 0 || isRoll;
      if (playsHat) {
        const subHits = isRoll ? 3 : 1;
        for (let h = 0; h < subHits; h++) {
          const ht = time + (h * T2_STEP_SEC) / 3;
          const hat = this.ctx.createBufferSource();
          hat.buffer = this.noiseBuffer;
          const hp = this.ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.setValueAtTime(isRoll ? 8200 : 7000, ht);
          const hg = this.ctx.createGain();
          hg.gain.setValueAtTime(isRoll ? 0.075 : 0.055, ht);
          hg.gain.exponentialRampToValueAtTime(0.001, ht + 0.036);
          hat.connect(hp);
          hp.connect(hg);
          hg.connect(this.musicFilter);
          hat.start(ht);
          hat.stop(ht + 0.04);
        }
      }
    }

    // 4. Aggressive Trap Brass Stabs on Hook & Bar 0
    if ((s === 0 && (isHook || bar === 0 || bar === 2)) || (isHook && s === 10)) {
      const chord = T2_CHORDS_BY_BAR[bar];
      const dur = T2_STEP_SEC * 4.2;
      for (const note of chord) {
        const f = NOTE_FREQ[note];
        if (!f) continue;
        const brass = this.ctx.createOscillator();
        brass.type = 'sawtooth';
        brass.frequency.setValueAtTime(f, time);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(isHook ? 2400 : 1400, time);
        lp.frequency.exponentialRampToValueAtTime(420, time + dur);
        const bg = this.ctx.createGain();
        bg.gain.setValueAtTime(0.001, time);
        bg.gain.linearRampToValueAtTime(isHook ? 0.075 : 0.05, time + 0.02);
        bg.gain.exponentialRampToValueAtTime(0.001, time + dur);
        brass.connect(lp);
        lp.connect(bg);
        bg.connect(this.musicFilter);
        brass.start(time);
        brass.stop(time + dur + 0.02);
      }
    }

    // 5. Rhythmic Rap Flow Vocal-Formant Cadence Hits
    if (!isBreak && (s === 2 || s === 5 || s === 11 || (isHook && s === 14))) {
      const pitch = s === 5 ? 207.65 : s === 11 ? 261.63 : 174.61;
      const formant = s === 11 ? 1420 : 880;
      this.triggerRapCadenceChop(time, pitch, formant, 0.11, isHook ? 0.11 : 0.085);
    }

    // 6. Dark Trap Bell / Flute Counter-Melody
    if (!isBreak) {
      const melodyArr = bar % 2 === 0 ? T2_FLUTE_BAR_A : T2_FLUTE_BAR_B;
      const mNote = melodyArr[s];
      if (mNote && NOTE_FREQ[mNote]) {
        const bell = this.ctx.createOscillator();
        bell.type = bar >= 4 ? 'triangle' : 'sine';
        bell.frequency.setValueAtTime(NOTE_FREQ[mNote], time);
        const lg = this.ctx.createGain();
        lg.gain.setValueAtTime(0.001, time);
        lg.gain.linearRampToValueAtTime(0.11, time + 0.01);
        lg.gain.exponentialRampToValueAtTime(0.001, time + T2_STEP_SEC * 2.8);
        bell.connect(lg);
        lg.connect(this.musicFilter);
        bell.start(time);
        bell.stop(time + T2_STEP_SEC * 2.9);
      }
    }
  }

  public playWhoosh(weight: 'light' | 'heavy' | 'dodge') {
    const ctx = this.ensureContext();
    if (!ctx || !this.noiseBuffer || !this.sfxGain) return;

    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    const startFreq = weight === 'dodge' ? 520 : weight === 'light' ? 760 : 380;
    const endFreq = weight === 'dodge' ? 220 : weight === 'light' ? 300 : 140;
    const dur = weight === 'heavy' ? 0.22 : 0.14;

    filter.frequency.setValueAtTime(startFreq, now);
    filter.frequency.exponentialRampToValueAtTime(endFreq, now + dur);
    filter.Q.value = 1.6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(weight === 'heavy' ? 0.16 : 0.11, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxGain);

    src.start(now);
    src.stop(now + dur + 0.02);
  }

  public playHit(type: AttackType, isCounter = false) {
    const ctx = this.ensureContext();
    if (!ctx || !this.noiseBuffer || !this.sfxGain) return;

    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = type === 'uppercut' ? 'triangle' : 'sine';
    const baseFreq =
      type === 'jab' ? 148 : type === 'hook' ? 118 : type === 'heavy' ? 98 : 108;
    osc.frequency.setValueAtTime(baseFreq * (isCounter ? 1.15 : 1), now);
    osc.frequency.exponentialRampToValueAtTime(34, now + (type === 'jab' ? 0.1 : 0.19));

    const oscGain = ctx.createGain();
    const punchVol =
      type === 'jab' ? 0.34 : type === 'hook' ? 0.52 : type === 'heavy' ? 0.56 : 0.6;
    oscGain.gain.setValueAtTime(punchVol, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + (type === 'jab' ? 0.12 : 0.22));

    osc.connect(oscGain);
    oscGain.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.24);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(type === 'jab' ? 1200 : type === 'hook' ? 1050 : 880, now);
    bp.Q.value = 0.9;

    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(type === 'jab' ? 0.24 : type === 'hook' ? 0.38 : 0.42, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    noise.connect(bp);
    bp.connect(nGain);
    nGain.connect(this.sfxGain);
    noise.start(now);
    noise.stop(now + 0.1);

    if (isCounter) {
      const sting = ctx.createOscillator();
      sting.type = 'sine';
      sting.frequency.setValueAtTime(640, now);
      sting.frequency.exponentialRampToValueAtTime(980, now + 0.08);
      const sGain = ctx.createGain();
      sGain.gain.setValueAtTime(0.14, now);
      sGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      sting.connect(sGain);
      sGain.connect(this.sfxGain);
      sting.start(now);
      sting.stop(now + 0.13);
    }
  }

  public playBlock() {
    const ctx = this.ensureContext();
    if (!ctx || !this.noiseBuffer || !this.sfxGain) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(65, now + 0.09);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.24, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.11);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(560, now);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.18, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    noise.connect(lp);
    lp.connect(ng);
    ng.connect(this.sfxGain);
    noise.start(now);
    noise.stop(now + 0.08);
  }

  public playBell(strikes = 1) {
    const ctx = this.ensureContext();
    if (!ctx || !this.sfxGain) return;

    for (let s = 0; s < strikes; s++) {
      const start = ctx.currentTime + s * 0.24;
      const freqs = [785, 1185, 1620, 2380];
      freqs.forEach((f, idx) => {
        const osc = ctx.createOscillator();
        osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(f, start);

        const g = ctx.createGain();
        const amp = idx === 0 ? 0.22 : 0.09 / idx;
        g.gain.setValueAtTime(amp, start);
        g.gain.exponentialRampToValueAtTime(0.0008, start + 1.15);

        osc.connect(g);
        g.connect(this.sfxGain!);
        osc.start(start);
        osc.stop(start + 1.2);
      });
    }
  }

  public playKnockdown() {
    const ctx = this.ensureContext();
    if (!ctx || !this.noiseBuffer || !this.sfxGain) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(84, now);
    osc.frequency.exponentialRampToValueAtTime(24, now + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.4);

    const roar = ctx.createBufferSource();
    roar.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(480, now);
    bp.Q.value = 0.65;
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.01, now);
    rg.gain.linearRampToValueAtTime(0.22, now + 0.18);
    rg.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
    roar.connect(bp);
    bp.connect(rg);
    rg.connect(this.sfxGain);
    roar.start(now);
    roar.stop(now + 1.15);
  }

  public playUiClick() {
    const ctx = this.ensureContext();
    if (!ctx || !this.sfxGain) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.04);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.055);
  }
}

export const soundEngine = new SoundEngine();

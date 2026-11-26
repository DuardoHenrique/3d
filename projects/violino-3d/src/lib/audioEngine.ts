import * as Tone from "tone";

export interface ViolinNote {
  note: string;
  freq: number;
  name: string;
  color: string;
}

export const VIOLIN_STRINGS: Record<string, ViolinNote> = {
  String_G: { note: "G3", freq: 196.0, name: "Sol (G3)", color: "#FF0055" }, // Electric Magenta
  String_D: { note: "D4", freq: 293.66, name: "Ré (D4)", color: "#00F5D4" }, // Cyber Cyan
  String_A: { note: "A4", freq: 440.0, name: "Lá (A4)", color: "#FF7B00" }, // Solar Amber
  String_E: { note: "E5", freq: 659.25, name: "Mi (E5)", color: "#7B2CBF" }, // Vivid Violet
};

class AudioEngine {
  private isInitialized = false;
  private isInitializing = false;
  private isMuted = false;

  private masterGain: Tone.Gain | null = null;
  private synth: Tone.PolySynth | null = null;
  private filter: Tone.Filter | null = null;
  private vibrato: Tone.Vibrato | null = null;
  private reverb: Tone.JCReverb | null = null;

  private rhythmLoop: Tone.Loop | null = null;
  private bassSynth: Tone.MembraneSynth | null = null;
  private hihatSynth: Tone.MetalSynth | null = null;
  private isRhythmPlaying = false;

  public async init(): Promise<boolean> {
    if (this.isInitialized) {
      if (this.isMuted) {
        this.toggleMute();
      }
      return true;
    }
    if (this.isInitializing) return false;

    this.isInitializing = true;
    try {
      // Unlock Web Audio Context
      await Tone.start();
      if (Tone.context.state !== "running") {
        await Tone.context.resume();
      }

      // Master output gain
      this.masterGain = new Tone.Gain(0.9).toDestination();

      // Soundbox resonance filter simulating spruce/maple violin body
      this.filter = new Tone.Filter({
        frequency: 3400,
        type: "lowpass",
        rolloff: -12,
        Q: 1.4,
      });

      // Subtle natural string vibrato
      this.vibrato = new Tone.Vibrato({
        frequency: 5.2,
        depth: 0.1,
      });

      // Lush real-time Schroeder reverberation (failsafe, zero offline delay)
      this.reverb = new Tone.JCReverb({
        roomSize: 0.62,
      });
      this.reverb.wet.value = 0.35;

      // Polyphonic string synth with rich harmonic sawtooth core
      this.synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: {
          type: "sawtooth",
        },
        envelope: {
          attack: 0.04,
          decay: 0.3,
          sustain: 0.75,
          release: 0.9,
        },
      });

      this.synth.volume.value = 0; // Loud and crystal clear

      // Direct clean signal path + reverb send
      this.synth.chain(this.filter, this.vibrato, this.masterGain);
      this.vibrato.connect(this.reverb);
      this.reverb.connect(this.masterGain);

      this.isInitialized = true;
      this.isMuted = false;
      return true;
    } catch (err) {
      console.error("AudioEngine initialization failed:", err);
      return false;
    } finally {
      this.isInitializing = false;
    }
  }

  public toggleMute(): boolean {
    if (!this.isInitialized) {
      this.init();
      return true;
    }

    this.isMuted = !this.isMuted;
    if (this.masterGain) {
      const targetGain = this.isMuted ? 0 : 0.9;
      this.masterGain.gain.rampTo(targetGain, 0.05);
    }

    return !this.isMuted;
  }

  public getIsReady(): boolean {
    return this.isInitialized;
  }

  public getIsMuted(): boolean {
    return this.isMuted;
  }

  public getIsActive(): boolean {
    return this.isInitialized && !this.isMuted;
  }

  public playString(stringId: string, duration = "4n") {
    if (this.isMuted) return;

    if (!this.isInitialized || !this.synth) {
      this.init().then(() => {
        if (!this.isMuted) this.playString(stringId, duration);
      });
      return;
    }

    // Ensure audio context is running
    if (Tone.context.state !== "running") {
      Tone.context.resume();
    }

    const stringData = VIOLIN_STRINGS[stringId];
    if (stringData && this.synth) {
      try {
        this.synth.triggerAttackRelease(stringData.note, duration);
      } catch (e) {
        console.warn("AudioEngine playString warning:", e);
      }
    }
  }

  public playNote(noteName: string, duration = "4n") {
    if (this.isMuted) return;

    if (!this.isInitialized || !this.synth) {
      this.init().then(() => {
        if (!this.isMuted) this.playNote(noteName, duration);
      });
      return;
    }

    if (Tone.context.state !== "running") {
      Tone.context.resume();
    }

    try {
      this.synth.triggerAttackRelease(noteName, duration);
    } catch (e) {
      console.warn("AudioEngine playNote warning:", e);
    }
  }

  public toggleRhythmLoop(bpm = 116): boolean {
    if (!this.isInitialized) {
      this.init().then(() => this.toggleRhythmLoop(bpm));
      return false;
    }

    if (this.isRhythmPlaying && this.rhythmLoop) {
      this.rhythmLoop.stop();
      Tone.getTransport().stop();
      this.isRhythmPlaying = false;
      return false;
    }

    if (Tone.context.state !== "running") {
      Tone.context.resume();
    }

    Tone.getTransport().bpm.value = bpm;

    if (!this.bassSynth) {
      this.bassSynth = new Tone.MembraneSynth({
        pitchDecay: 0.05,
        octaves: 4,
        envelope: { attack: 0.002, decay: 0.35, sustain: 0.01, release: 0.35 },
      }).connect(this.masterGain || Tone.getDestination());
      this.bassSynth.volume.value = -3;
    }

    if (!this.hihatSynth) {
      this.hihatSynth = new Tone.MetalSynth({
        envelope: { attack: 0.001, decay: 0.04, release: 0.04 },
        harmonicity: 4.8,
        modulationIndex: 28,
        resonance: 4000,
        octaves: 1.5,
      }).connect(this.masterGain || Tone.getDestination());
      this.hihatSynth.volume.value = -14;
    }

    let step = 0;
    this.rhythmLoop = new Tone.Loop((time) => {
      // 16-step neo-classical cyber beat
      if (step % 4 === 0) {
        this.bassSynth?.triggerAttackRelease("C2", "8n", time, 0.95);
      } else if (step % 4 === 2) {
        this.bassSynth?.triggerAttackRelease("G1", "8n", time, 0.75);
      }

      if (step % 2 === 1) {
        this.hihatSynth?.triggerAttackRelease("32n", time, 0.45);
      }

      step = (step + 1) % 16;
    }, "16n");

    this.rhythmLoop.start(0);
    Tone.getTransport().start();
    this.isRhythmPlaying = true;
    return true;
  }

  public getIsRhythmPlaying(): boolean {
    return this.isRhythmPlaying;
  }
}

export const audioEngine = new AudioEngine();

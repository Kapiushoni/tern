// A very soft two-note chime, synthesized (no audio files, nothing loaded until first use).

let ctx: AudioContext | null = null;

export function chime(volume = 0.05) {
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    // Two gentle sine notes (E6 then A5), each with a soft attack and a long fade.
    [
      [1318.5, 0],
      [880, 0.11],
    ].forEach(([freq, at]) => {
      const osc = ctx!.createOscillator();
      const g = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, now + at);
      g.gain.linearRampToValueAtTime(1, now + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, now + at + 0.6);
      osc.connect(g).connect(master);
      osc.start(now + at);
      osc.stop(now + at + 0.65);
    });
  } catch {
    // No audio device: stay silent.
  }
}

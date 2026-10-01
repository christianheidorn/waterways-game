const MUTE_KEY = 'waterways.muted';

/**
 * Synthesised weather sound (no audio files): rain hiss and wind loops made from filtered noise,
 * and thunder claps (crack + rumbling brown noise) scheduled with the speed-of-sound delay.
 *
 * Browsers only allow audio after a user gesture, so the AudioContext is created on the first
 * pointer / key event. Muted while the tab is hidden, or when localStorage `waterways.muted` = "1".
 */
export class WeatherAudio {
    private ctx: AudioContext | null = null;
    private master: GainNode | null = null;
    private rainGain: GainNode | null = null;
    private rainHeavyGain: GainNode | null = null;
    private windGain: GainNode | null = null;
    private windFilter: BiquadFilterNode | null = null;
    private surfGain: GainNode | null = null;
    private surfCrashGain: GainNode | null = null;
    private surfFilter: BiquadFilterNode | null = null;
    private surf = 0;
    private surfCrash = 0;
    private lastSurf = -1;
    private lastSurfCrash = -1;
    private brown: AudioBuffer | null = null;
    private white: AudioBuffer | null = null;
    private muted = false;
    private rain = 0;
    private wind = 0;
    private lastRain = -1;
    private lastWind = -1;
    private readonly unlock = () => this.start();
    private readonly visibility = () => this.applyMute();

    constructor() {
        try {
            this.muted = window.localStorage.getItem(MUTE_KEY) === '1';
        } catch {
            this.muted = false;
        }

        for (const type of ['pointerdown', 'keydown', 'touchstart']) {
            window.addEventListener(type, this.unlock, {
                capture: true,
                passive: true,
            });
        }

        document.addEventListener('visibilitychange', this.visibility);
    }

    setMuted(muted: boolean): void {
        this.muted = muted;

        try {
            window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
        } catch {
            // Storage unavailable: mute only for this session.
        }

        this.applyMute();
    }

    get isMuted(): boolean {
        return this.muted;
    }

    /** Continuous ambience levels (0-1), smoothed by the audio graph. */
    setAmbience(rain: number, wind: number): void {
        this.rain = rain;
        this.wind = wind;
        const ctx = this.ctx;

        if (
            !ctx ||
            !this.rainGain ||
            !this.rainHeavyGain ||
            !this.windGain ||
            !this.windFilter
        ) {
            return;
        }

        if (Math.abs(rain - this.lastRain) > 0.01) {
            this.lastRain = rain;
            this.rainGain.gain.setTargetAtTime(
                Math.min(1, rain * 1.2) * 0.22,
                ctx.currentTime,
                0.4,
            );
            this.rainHeavyGain.gain.setTargetAtTime(
                Math.max(0, rain - 0.35) * 0.35,
                ctx.currentTime,
                0.6,
            );
        }

        if (Math.abs(wind - this.lastWind) > 0.01) {
            this.lastWind = wind;
            const w = Math.min(1.5, wind);
            this.windGain.gain.setTargetAtTime(
                Math.max(0, w - 0.15) * 0.09,
                ctx.currentTime,
                0.3,
            );
            this.windFilter.frequency.setTargetAtTime(
                220 + w * 380,
                ctx.currentTime,
                0.3,
            );
        }
    }

    /**
     * Surf / lapping on nearby beaches (0-1, Water.surf.activity): a low wash that swells with `level`
     * and a brighter crash (`crash`, 0-1) while the nearest waves break and run up the sand.
     */
    setSurf(level: number, crash: number): void {
        this.surf = level;
        this.surfCrash = crash;
        const ctx = this.ctx;

        if (!ctx || !this.surfGain || !this.surfCrashGain || !this.surfFilter) {
            return;
        }

        if (Math.abs(level - this.lastSurf) > 0.005) {
            this.lastSurf = level;
            this.surfGain.gain.setTargetAtTime(
                Math.min(1, level) * 0.16,
                ctx.currentTime,
                0.5,
            );
        }

        const c = Math.min(1, level) * crash;

        if (Math.abs(c - this.lastSurfCrash) > 0.01) {
            this.lastSurfCrash = c;
            this.surfCrashGain.gain.setTargetAtTime(
                c * 0.2,
                ctx.currentTime,
                0.12,
            );
            this.surfFilter.frequency.setTargetAtTime(
                700 + crash * 1300,
                ctx.currentTime,
                0.15,
            );
        }
    }

    /**
     * Water sounds near the listener (WaterInteraction): a slosh per wading step, a stroke while swimming,
     * a splash (volume 0-1 grows with the impact) — short filtered noise bursts.
     */
    waterSound(kind: 'step' | 'splash' | 'stroke', volume: number): void {
        const ctx = this.ctx;

        if (!ctx || !this.master || !this.white || volume <= 0) {
            return;
        }

        const start = ctx.currentTime + 0.005;
        const splash = kind === 'splash';
        const duration = splash
            ? 0.5 + volume * 0.9
            : kind === 'step'
              ? 0.22 + Math.random() * 0.1
              : 0.35;
        const src = ctx.createBufferSource();
        src.buffer = this.white;
        src.playbackRate.value = 0.8 + Math.random() * 0.4;
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        const f0 = splash
            ? 1400 + Math.random() * 600
            : 500 + Math.random() * 450;
        band.frequency.setValueAtTime(f0, start);
        // The slosh drops in pitch as the water settles.
        band.frequency.exponentialRampToValueAtTime(
            f0 * 0.45,
            start + duration,
        );
        band.Q.value = splash ? 0.6 : 1.4;
        const g = ctx.createGain();
        const peak = volume * (splash ? 0.5 : 0.22);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(
            peak,
            start + (splash ? 0.012 : 0.04),
        );
        g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        src.connect(band).connect(g).connect(this.master);
        src.start(start, Math.random() * 1.5);
        src.stop(start + duration + 0.05);
    }

    /** Thunder for a strike `distance` metres away (delayed by the speed of sound). */
    thunder(distance: number, volume: number): void {
        const ctx = this.ctx;

        if (!ctx || !this.master || !this.brown || !this.white || volume <= 0) {
            return;
        }

        const delay = distance / 343;
        const start = ctx.currentTime + delay;
        const near = Math.max(0, 1 - distance / 1400);
        const gainScale = volume * (1.1 / (1 + distance / 1200));
        // Rumble: long brown noise, low-passed harder the further away the strike is.
        const rumble = ctx.createBufferSource();
        rumble.buffer = this.brown;
        rumble.playbackRate.value = 0.8 + Math.random() * 0.3;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        const cutoff = 140 + near * 900 + Math.random() * 120;
        lp.frequency.setValueAtTime(cutoff, start);
        lp.frequency.exponentialRampToValueAtTime(
            Math.max(60, cutoff * 0.35),
            start + 5,
        );
        const g = ctx.createGain();
        const attack = 0.03 + (1 - near) * 0.35;
        const duration = 4 + Math.random() * 4 + (1 - near) * 2;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(gainScale, start + attack);
        // A few rolling swells.
        let t = start + attack;

        for (let i = 0; i < 4; i++) {
            t += 0.3 + Math.random() * 0.9;
            const level =
                gainScale *
                (0.35 + Math.random() * 0.6) *
                Math.exp(-(t - start) / duration) *
                1.6;
            g.gain.linearRampToValueAtTime(Math.max(0.0002, level), t);
        }

        g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        rumble.connect(lp).connect(g).connect(this.master);
        rumble.start(start, Math.random() * 2, duration + 0.5);
        rumble.stop(start + duration + 0.5);

        // Close strikes: a sharp tearing crack before the rumble.
        if (near > 0) {
            const crack = ctx.createBufferSource();
            crack.buffer = this.white;
            const hp = ctx.createBiquadFilter();
            hp.type = 'bandpass';
            hp.frequency.value = 1800 + Math.random() * 1500;
            hp.Q.value = 0.5;
            const cg = ctx.createGain();
            cg.gain.setValueAtTime(0.0001, start);
            cg.gain.exponentialRampToValueAtTime(
                volume * near * 0.9,
                start + 0.008,
            );
            cg.gain.exponentialRampToValueAtTime(
                0.0001,
                start + 0.35 + near * 0.3,
            );
            crack.connect(hp).connect(cg).connect(this.master);
            crack.start(start, Math.random());
            crack.stop(start + 0.8);
        }
    }

    dispose(): void {
        for (const type of ['pointerdown', 'keydown', 'touchstart']) {
            window.removeEventListener(type, this.unlock, { capture: true });
        }

        document.removeEventListener('visibilitychange', this.visibility);
        void this.ctx?.close();
        this.ctx = null;
    }

    private start(): void {
        for (const type of ['pointerdown', 'keydown', 'touchstart']) {
            window.removeEventListener(type, this.unlock, { capture: true });
        }

        if (this.ctx) {
            void this.ctx.resume();

            return;
        }

        const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;

        if (!Ctor) {
            return;
        }

        const ctx = new Ctor();
        this.ctx = ctx;
        this.brown = noiseBuffer(ctx, 10, 'brown');
        this.white = noiseBuffer(ctx, 2, 'white');
        const pink = noiseBuffer(ctx, 4, 'pink');

        this.master = ctx.createGain();
        this.master.connect(ctx.destination);

        // Rain: bright hiss + a lower "heavy rain" wash.
        const rainSrc = loop(ctx, pink);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 900;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 9000;
        this.rainGain = ctx.createGain();
        this.rainGain.gain.value = 0;
        rainSrc
            .connect(hp)
            .connect(lp)
            .connect(this.rainGain)
            .connect(this.master);

        const heavySrc = loop(ctx, this.brown);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 500;
        bp.Q.value = 0.4;
        this.rainHeavyGain = ctx.createGain();
        this.rainHeavyGain.gain.value = 0;
        heavySrc.connect(bp).connect(this.rainHeavyGain).connect(this.master);

        // Wind: low-passed brown noise, gusts come from setAmbience().
        const windSrc = loop(ctx, this.brown, 3.3);
        this.windFilter = ctx.createBiquadFilter();
        this.windFilter.type = 'lowpass';
        this.windFilter.frequency.value = 300;
        this.windFilter.Q.value = 1.5;
        this.windGain = ctx.createGain();
        this.windGain.gain.value = 0;
        windSrc
            .connect(this.windFilter)
            .connect(this.windGain)
            .connect(this.master);

        // Surf: a low brown-noise wash and a brighter pink-noise crash as the waves break.
        const washSrc = loop(ctx, this.brown, 6.1);
        const washFilter = ctx.createBiquadFilter();
        washFilter.type = 'lowpass';
        washFilter.frequency.value = 520;
        this.surfGain = ctx.createGain();
        this.surfGain.gain.value = 0;
        washSrc.connect(washFilter).connect(this.surfGain).connect(this.master);
        const crashSrc = loop(ctx, pink, 1.7);
        this.surfFilter = ctx.createBiquadFilter();
        this.surfFilter.type = 'bandpass';
        this.surfFilter.frequency.value = 900;
        this.surfFilter.Q.value = 0.35;
        this.surfCrashGain = ctx.createGain();
        this.surfCrashGain.gain.value = 0;
        crashSrc
            .connect(this.surfFilter)
            .connect(this.surfCrashGain)
            .connect(this.master);

        this.lastRain = -1;
        this.lastWind = -1;
        this.lastSurf = -1;
        this.lastSurfCrash = -1;
        this.applyMute();
        this.setAmbience(this.rain, this.wind);
        this.setSurf(this.surf, this.surfCrash);
        void ctx.resume();
    }

    private applyMute(): void {
        if (!this.master || !this.ctx) {
            return;
        }

        const silent = this.muted || document.hidden;
        this.master.gain.setTargetAtTime(
            silent ? 0 : 1,
            this.ctx.currentTime,
            0.1,
        );
    }
}

function loop(
    ctx: AudioContext,
    buffer: AudioBuffer,
    offset = 0,
): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start(0, offset % buffer.duration);

    return src;
}

function noiseBuffer(
    ctx: AudioContext,
    seconds: number,
    kind: 'white' | 'pink' | 'brown',
): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const fade = Math.min(4096, Math.floor(length / 8));
    // Generate `fade` extra samples and blend them into the start so the loop point is seamless.
    const data = new Float32Array(length + fade);
    let last = 0;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;

    for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;

        if (kind === 'white') {
            data[i] = white * 0.5;
        } else if (kind === 'brown') {
            last = (last + 0.02 * white) / 1.02;
            data[i] = last * 3.5;
        } else {
            // Paul Kellet's pink noise filter.
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.969 * b2 + white * 0.153852;
            b3 = 0.8665 * b3 + white * 0.3104856;
            b4 = 0.55 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.016898;
            data[i] =
                (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
            b6 = white * 0.115926;
        }
    }

    for (let i = 0; i < fade; i++) {
        const t = i / fade;
        data[i] = data[i] * t + data[length + i] * (1 - t);
    }

    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    buffer.copyToChannel(data.subarray(0, length), 0);

    return buffer;
}

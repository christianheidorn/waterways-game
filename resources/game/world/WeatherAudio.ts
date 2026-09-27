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

        this.lastRain = -1;
        this.lastWind = -1;
        this.applyMute();
        this.setAmbience(this.rain, this.wind);
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

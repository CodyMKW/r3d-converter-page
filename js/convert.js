/*
 * convert.js - turns a scanned .r3d recording into an MP4 in the browser.
 *
 *   scan (r3d.js)  ->  RecordingPlayer (decode frames)  ->  Composer (lay the screens out)
 *     -> VideoEncoder (H.264, falling back to VP9 / AV1)   -> mp4-muxer -> .mp4 Blob
 *   audio frames   ->  timeline + resampler (r3d.js)       -> AudioEncoder (AAC, falling back to Opus) -> mp4-muxer
 *
 * Needs a browser with WebCodecs (Chrome / Edge / Safari 16.4+ / recent Firefox) and r3d.js + vendor/mp4-muxer.js loaded.
 */
(function (root) {
    'use strict';
    const R3D = root.R3D;
    const ROWS = R3D.ROWS;

    const CODEC_INFO = {
        Y: { name: 'XR32', note: 'lossless, changed pixels only' },
        H: { name: 'XR32 + Huffman', note: 'lossless, squeezed a bit more' },
        Q: { name: 'Q565', note: 'lossless, a picture on its own' },
        C: { name: 'C420', note: 'lossy, like video, for busy scenes' },
        X: { name: 'XOR-RLE', note: 'lossless, the older format' },
        F: { name: 'Raw', note: 'uncompressed RGB565' },
    };

    const NTP_TO_UNIX_MS = 2208988800000; // the 3DS clock counts from 1900-01-01

    /* ------------------------------------------------------------------------------- facts about a file */

    function summarize(info) {
        const h = info.header;
        const counts = info.counts || {};
        const bytes = info.bytes || {};
        const codecs = [];
        for (const t of 'YHQCXF') {
            if (counts[t]) codecs.push({ type: t, ...CODEC_INFO[t], frames: counts[t], bytes: bytes[t] || 0 });
        }
        const audioSeconds = h.audioRate ? (info.audio.reduce((s, f) => s + f.n, 0) / h.audioRate) : 0;
        let date = null;
        const unixMs = h.startTimeMs - NTP_TO_UNIX_MS;
        if (unixMs > 1.3e12 && unixMs < 4.1e12) date = new Date(unixMs);
        return {
            seconds: info.durationUs / 1e6,
            fps: h.fps,
            console: h.isNew3ds ? 'New 3DS' : 'Old 3DS',
            modeName: h.modeName,
            framesTop: info.video[0].length,
            framesBottom: info.video[1].length,
            hasTop: info.video[0].length > 0,
            hasBottom: info.video[1].length > 0,
            hasAudio: info.audio.length > 0 && h.audioRate > 0,
            audioSeconds,
            codecs,
            audioBytes: bytes.A || 0,
            fileSize: info.fileSize,
            dropped: info.end ? info.end.dropped : 0,
            cutOff: info.truncated,
            wholeConsole: /^0+$/.test(h.titleId),
            version: h.version,
            date,
        };
    }

    function formatBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 1e7 ? 1 : 0) + ' MB';
        return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    function formatDuration(sec) {
        const m = Math.floor(sec / 60);
        const s = sec - m * 60;
        return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }

    /* ----------------------------------------------------------------------------------------- player */

    /**
     * Decodes a scanned recording on demand. Keeps the current picture of each screen; `advanceTo` plays forward,
     * `seek` jumps (from the nearest key frame), `render` turns changed screens into RGBA ImageData.
     */
    class RecordingPlayer {
        constructor(source, info) {
            this.info = info;
            this.reader = new R3D.WindowReader(source, 4 * 1024 * 1024);
            this.images = [null, null];
            this.px = [null, null];
            this.cols = [0, 0];
            this.rev = [0, 0]; // bumps whenever a screen's image changed
            this.reset();
        }
        reset() {
            this.dec = [new R3D.ScreenDecoder(), new R3D.ScreenDecoder()];
            this.ptr = [0, 0];
            this.shown = [-1, -1];
            this.dirty = [false, false];
            this.errors = 0;
        }
        async _decode(s, i) {
            const e = this.info.video[s][i];
            const payload = await R3D.readPayload(this.reader, e);
            if (!this.dec[s].apply(e, payload)) this.errors++;
            this.shown[s] = i;
            this.dirty[s] = true;
        }
        /** Decodes every frame up to time t (microseconds). The first frame of a screen is always shown. */
        async advanceTo(t) {
            for (let s = 0; s < 2; s++) {
                const list = this.info.video[s];
                if (!list.length) continue;
                const limit = Math.max(t, list[0].t);
                while (this.ptr[s] < list.length && list[this.ptr[s]].t <= limit) {
                    await this._decode(s, this.ptr[s]);
                    this.ptr[s]++;
                }
            }
        }
        /** Jumps to time t, decoding from the nearest key frame (or just onward if that is cheaper). */
        async seek(t) {
            for (let s = 0; s < 2; s++) {
                const list = this.info.video[s];
                if (!list.length) continue;
                const limit = Math.max(t, list[0].t);
                let lo = 0, hi = list.length - 1, target = 0;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    if (list[mid].t <= limit) { target = mid; lo = mid + 1; } else hi = mid - 1;
                }
                if (target === this.shown[s]) continue;
                let kf = target;
                while (kf > 0 && !list[kf].key) kf--;
                const shown = this.shown[s];
                const start = shown >= 0 && target > shown && kf <= shown ? shown + 1 : kf;
                for (let i = start; i <= target; i++) await this._decode(s, i);
                this.ptr[s] = target + 1;
            }
        }
        /** Converts changed screens to RGBA. Returns true when anything changed. */
        render() {
            let changed = false;
            for (let s = 0; s < 2; s++) {
                if (!this.dirty[s]) continue;
                const cols = this.dec[s].cols;
                if (!this.images[s] || this.cols[s] !== cols) {
                    this.images[s] = new ImageData(cols, ROWS);
                    this.px[s] = new Uint32Array(this.images[s].data.buffer);
                    this.cols[s] = cols;
                }
                R3D.frameToRGBA(this.dec[s].frame, cols, this.px[s]);
                this.dirty[s] = false;
                this.rev[s]++;
                changed = true;
            }
            return changed;
        }
    }

    /* --------------------------------------------------------------------------------------- composer */

    function makeCanvas(w, h) {
        if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
    }

    const QUALITY_BPP = { small: 0.12, balanced: 0.25, high: 0.5 };
    const SCALE_BITRATE = [0, 1, 1.6, 2.2];

    /** Which screens a layout uses and how big the picture is at 1x (top above bottom, bottom centred). */
    function layoutSize(info, layout) {
        const v = info.video;
        const want = layout === 'top' ? [0] : layout === 'bottom' ? [1] : [0, 1];
        let screens = want.filter((s) => v[s].length > 0);
        if (!screens.length) screens = [0, 1].filter((s) => v[s].length > 0);
        let w = 0;
        for (const s of screens) w = Math.max(w, v[s][0].cols);
        return { screens, w, h: ROWS * screens.length };
    }

    /** Video bits per second for a picture size, quality and scale. */
    function targetBitrate(w, h, fps, quality, scale) {
        return Math.max(500000, Math.round(w * h * fps * (QUALITY_BPP[quality] || 0.25) * (SCALE_BITRATE[scale] || 1)));
    }

    /** Lays the chosen screens out (top above bottom, bottom centred) and scales with sharp pixels. */
    class Composer {
        constructor(player, layout, scale) {
            const lay = layoutSize(player.info, layout);
            this.screens = lay.screens;
            this.scale = scale;
            this.w = lay.w;
            this.h = lay.h;
            this.outW = this.w * scale;
            this.outH = this.h * scale;
            this.base = makeCanvas(this.w, this.h);
            this.baseCtx = this.base.getContext('2d', { alpha: false });
            this.baseCtx.fillStyle = '#000';
            this.baseCtx.fillRect(0, 0, this.w, this.h);
            if (scale > 1) {
                this.out = makeCanvas(this.outW, this.outH);
                this.outCtx = this.out.getContext('2d', { alpha: false });
                this.outCtx.imageSmoothingEnabled = false;
            } else {
                this.out = this.base;
            }
            this.seen = [-1, -1];
        }
        /** Draws screens whose image changed since the last call. */
        draw(player) {
            let any = false;
            this.screens.forEach((s, row) => {
                const img = player.images[s];
                if (!img || this.seen[s] === player.rev[s]) return;
                this.baseCtx.putImageData(img, Math.floor((this.w - img.width) / 2), row * ROWS);
                this.seen[s] = player.rev[s];
                any = true;
            });
            if (any && this.scale > 1) this.outCtx.drawImage(this.base, 0, 0, this.outW, this.outH);
            return any;
        }
        get canvas() { return this.out; }
    }

    /* ----------------------------------------------------------------------------- encoder selection */

    const VIDEO_CANDIDATES = [
        { codec: 'avc1.640028', mux: 'avc', name: 'H.264' },
        { codec: 'avc1.64002A', mux: 'avc', name: 'H.264' },
        { codec: 'avc1.4D0028', mux: 'avc', name: 'H.264' },
        { codec: 'avc1.42E028', mux: 'avc', name: 'H.264' },
        { codec: 'vp09.00.40.08', mux: 'vp9', name: 'VP9' },
        { codec: 'av01.0.08M.08', mux: 'av1', name: 'AV1' },
    ];
    const AUDIO_CANDIDATES = [
        { codec: 'mp4a.40.2', mux: 'aac', name: 'AAC', bitrate: 160000 },
        { codec: 'opus', mux: 'opus', name: 'Opus', bitrate: 128000 },
    ];
    const AUDIO_RATE = 48000;

    async function pickVideo(width, height, fps, bitrate) {
        if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
        for (const c of VIDEO_CANDIDATES) {
            const config = { codec: c.codec, width, height, bitrate, framerate: fps, latencyMode: 'quality' };
            if (c.mux === 'avc') config.avc = { format: 'avc' };
            try {
                const r = await VideoEncoder.isConfigSupported(config);
                if (r && r.supported) return { ...c, config };
            } catch (e) { /* try the next one */ }
        }
        return null;
    }

    async function pickAudio() {
        if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
        for (const c of AUDIO_CANDIDATES) {
            const config = { codec: c.codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: c.bitrate };
            try {
                const r = await AudioEncoder.isConfigSupported(config);
                if (r && r.supported) return { ...c, config };
            } catch (e) { /* try the next one */ }
        }
        return null;
    }

    /** What this browser will produce, for showing before the person presses Convert. */
    async function probe() {
        const v = await pickVideo(400, 480, 30, 2000000);
        const a = await pickAudio();
        return { video: v ? v.name : null, audio: a ? a.name : null };
    }

    /* ---------------------------------------------------------------------------------------- convert */

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function abortError() {
        const e = new Error('Cancelled');
        e.name = 'AbortError';
        return e;
    }

    /**
     * @param {RecordingPlayer} player
     * @param {{layout:'both'|'top'|'bottom', scale:1|2|3, quality:'small'|'balanced'|'high', sound:boolean}} opts
     * @param {{onStage?:Function, onProgress?:Function, onPreview?:Function, cancelled?:Function}} hooks
     * @returns {Promise<{blob:Blob, video:string, audio:string|null, width:number, height:number, fps:number, frames:number, seconds:number}>}
     */
    async function convert(player, opts, hooks) {
        hooks = hooks || {};
        const info = player.info;
        const fps = Math.min(60, Math.max(1, info.header.fps || 30));
        const comp = new Composer(player, opts.layout, opts.scale);
        const cancelled = () => hooks.cancelled && hooks.cancelled();
        const stage = (s) => hooks.onStage && hooks.onStage(s);
        const progress = (f, extra) => hooks.onProgress && hooks.onProgress(Math.min(1, Math.max(0, f)), extra);

        if (typeof Mp4Muxer === 'undefined') throw new Error('The MP4 writer did not load (vendor/mp4-muxer.js). Reload the page and try again.');
        const bitrate = targetBitrate(comp.w, comp.h, fps, opts.quality, opts.scale);
        const vcfg = await pickVideo(comp.outW, comp.outH, fps, bitrate);
        if (!vcfg) {
            throw new Error('This browser cannot encode video (no WebCodecs encoder). Try a recent Chrome, Edge or Safari on a computer.');
        }
        const wantAudio = !!opts.sound && info.audio.length > 0 && info.header.audioRate > 0;
        const acfg = wantAudio ? await pickAudio() : null;

        const target = new Mp4Muxer.ArrayBufferTarget();
        const muxer = new Mp4Muxer.Muxer({
            target,
            video: { codec: vcfg.mux, width: comp.outW, height: comp.outH, frameRate: fps },
            audio: acfg ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: AUDIO_RATE } : undefined,
            fastStart: 'in-memory',
            firstTimestampBehavior: 'cross-track-offset',
        });

        let encError = null;
        let venc = null, aenc = null;
        try {
            /* ---- sound: mixed and resampled up front, then fed to the encoder in step with the picture so the
                   file comes out interleaved (the muxer keeps the order it is given) ---- */
            let rs = null;
            let audioPos = 0; // next output sample to hand to the encoder
            const AUDIO_CHUNK = 4800; // 100 ms
            const feedAudio = async (untilSec) => {
                while (rs && audioPos < rs.frames && audioPos / AUDIO_RATE <= untilSec) {
                    const n = Math.min(AUDIO_CHUNK, rs.frames - audioPos);
                    const data = new Float32Array(n * 2);
                    data.set(rs.left.subarray(audioPos, audioPos + n), 0);
                    data.set(rs.right.subarray(audioPos, audioPos + n), n);
                    const ad = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((audioPos / AUDIO_RATE) * 1e6), data });
                    aenc.encode(ad);
                    ad.close();
                    audioPos += n;
                    if (encError) throw encError;
                    while (aenc.encodeQueueSize > 16) await sleep(2);
                }
            };
            if (acfg) {
                stage('Mixing the sound');
                await sleep(0);
                const tl = R3D.buildAudioTimeline(info.audio, info.header.audioRate, info.durationUs);
                await sleep(0);
                rs = R3D.resampleStereo(tl.pcm, info.header.audioRate, AUDIO_RATE);
                aenc = new AudioEncoder({
                    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
                    error: (e) => { encError = e; },
                });
                aenc.configure(acfg.config);
            }

            /* ---- picture ---- */
            stage('Converting the picture');
            venc = new VideoEncoder({
                output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
                error: (e) => { encError = e; },
            });
            venc.configure(vcfg.config);
            player.reset();
            const frameUs = 1e6 / fps;
            const total = Math.max(1, Math.ceil((info.durationUs * fps) / 1e6 - 1e-6));
            let lastYield = performance.now(), lastPreview = 0;
            for (let k = 0; k < total; k++) {
                if (cancelled()) throw abortError();
                const T = k * frameUs;
                await player.advanceTo(T + frameUs / 2); // the frame nearest to this tick
                player.render();
                comp.draw(player);
                const vf = new VideoFrame(comp.canvas, { timestamp: Math.round(T), duration: Math.round(frameUs) });
                venc.encode(vf, { keyFrame: k % Math.max(1, Math.round(fps * 2)) === 0 });
                vf.close();
                if (encError) throw encError;
                while (venc.encodeQueueSize > 8) {
                    await sleep(2);
                    if (encError) throw encError;
                }
                await feedAudio(T / 1e6 + 0.3); // keep the sound about 300 ms ahead of the picture
                const now = performance.now();
                if (hooks.onPreview && now - lastPreview > 90) {
                    lastPreview = now;
                    hooks.onPreview(player, T);
                }
                if (now - lastYield > 40) {
                    progress(0.02 + 0.96 * ((k + 1) / total), { frame: k + 1, frames: total, timeUs: T });
                    await sleep(0);
                    lastYield = performance.now();
                }
            }
            if (hooks.onPreview) hooks.onPreview(player, total * frameUs);
            stage('Packing the MP4');
            await feedAudio(Infinity);
            await venc.flush();
            venc.close();
            venc = null;
            if (aenc) {
                await aenc.flush();
                aenc.close();
                aenc = null;
            }
            if (encError) throw encError;
            muxer.finalize();
            progress(1);
            const blob = new Blob([target.buffer], { type: 'video/mp4' });
            return {
                blob,
                video: vcfg.name,
                audio: acfg ? acfg.name : null,
                soundSkipped: wantAudio && !acfg,
                width: comp.outW,
                height: comp.outH,
                fps,
                frames: total,
                seconds: total / fps,
                decodeErrors: player.errors,
            };
        } finally {
            try { if (venc && venc.state !== 'closed') venc.close(); } catch (e) { /* already closed */ }
            try { if (aenc && aenc.state !== 'closed') aenc.close(); } catch (e) { /* already closed */ }
        }
    }

    root.R3DConvert = { summarize, formatBytes, formatDuration, RecordingPlayer, Composer, layoutSize, targetBitrate, probe, convert, CODEC_INFO };
})(typeof self !== 'undefined' ? self : this);

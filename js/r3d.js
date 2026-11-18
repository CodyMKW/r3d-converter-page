/*
 * r3d.js - reader and decoders for the .r3d recording format of 3DS Recorder
 * (https://github.com/BolgarMaxym97/3ds-recorder, MIT license).
 *
 * The record layout and every frame decoder in here is a JavaScript port of the format described in that
 * project's codec/include/r3d_format.h, codec.h and huff.h and of its reference decoders in
 * codec/source/codec.c and huff.c. See NOTICE.md.
 *
 * Works in a browser (global `R3D`) and in Node (`require`), no dependencies.
 *
 * File layout (little-endian, every record 16-byte aligned):
 *   FileHeader (32 bytes), then records: RecHeader (16 bytes) + payload.
 *   Frames are column-major RGB565 as the LCD stores them: column = screen x, word 0 = bottom row.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.R3D = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const ROWS = 240;
    const WRAP = 4294967296; // timeUs is a u32 microsecond counter

    const tag = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
    const MAGIC_FILE = tag('R3DB');
    const MAGIC_RING = tag('R3DR');
    // record magic -> short type name
    const TYPES = new Map([
        [tag('R3DF'), 'F'], // raw RGB565 frame
        [tag('R3DX'), 'X'], // XOR-RLE frame
        [tag('R3DY'), 'Y'], // XR32 frame
        [tag('R3DH'), 'H'], // XR32 + Huffman
        [tag('R3DQ'), 'Q'], // Q565 (a picture on its own)
        [tag('R3DC'), 'C'], // C420 (a lossy picture on its own)
        [tag('R3DP'), 'P'], // padding (ring wrap)
        [tag('R3DA'), 'A'], // audio
        [tag('R3DM'), 'M'], // DSP memory snapshot (diagnostics)
        [tag('R3DE'), 'E'], // end of file
    ]);
    const VIDEO_TYPES = 'FXYHQC';

    const MODE_NAMES = { 3: 'top screen', 4: 'both screens', 5: 'bottom screen' };

    class R3DError extends Error {}

    /* ---------------------------------------------------------------------------------------- header */

    function parseHeader(u8) {
        if (u8.length < 32) throw new R3DError('That file is too short to be a recording.');
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const magic = dv.getUint32(0, true);
        if (magic === MAGIC_RING) {
            throw new R3DError('This is a replay clip (.rpl), not a finished recording. Convert it to an .r3d with 3DS Recorder first.');
        }
        if (magic !== MAGIC_FILE) throw new R3DError('This does not look like a 3DS Recorder .r3d file.');
        const hex8 = (v) => v.toString(16).padStart(8, '0');
        return {
            version: dv.getUint32(4, true),
            titleId: hex8(dv.getUint32(12, true)) + hex8(dv.getUint32(8, true)), // 0 = whole console
            isNew3ds: u8[16] !== 0,
            mode: u8[17],
            modeName: MODE_NAMES[u8[17]] || 'unknown',
            fps: u8[18] || 30,
            flags: u8[19],
            audioRate: dv.getUint32(20, true) / 1000, // Hz; 0 = no audio
            startTimeMs: dv.getUint32(24, true) + dv.getUint32(28, true) * WRAP,
        };
    }

    /* ----------------------------------------------------------------------- windowed random access */

    /** Reads a source (anything with `size` and async `read(offset, length) -> Uint8Array`) through a big window. */
    class WindowReader {
        constructor(source, windowSize) {
            this.source = source;
            this.size = source.size;
            this.windowSize = windowSize || 8 * 1024 * 1024;
            this.win = null;
            this.winOff = 0;
        }
        /** A view of [off, off + len), or null when the file ends first. Valid until the next call. */
        async get(off, len) {
            if (off < 0 || off + len > this.size) return null;
            const w = this.win;
            if (w && off >= this.winOff && off + len <= this.winOff + w.length) {
                return w.subarray(off - this.winOff, off - this.winOff + len);
            }
            const want = Math.min(Math.max(len, this.windowSize), this.size - off);
            this.win = await this.source.read(off, want);
            this.winOff = off;
            if (this.win.length < len) return null;
            return this.win.subarray(0, len);
        }
    }

    /* ----------------------------------------------------------------------------------------- scan */

    /**
     * Walks every record once. Video payloads are not kept (only their position, so they can be decoded later),
     * audio is copied out. Resolves to { header, video: [ [top entries], [bottom entries] ], audio, end, ... }.
     */
    async function scan(source, onProgress) {
        const reader = new WindowReader(source);
        const size = source.size;
        const head = await reader.get(0, Math.min(32, size));
        if (!head) throw new R3DError('That file is empty.');
        const header = parseHeader(head);

        const video = [[], []];
        const audio = [];
        const counts = {};
        const bytes = {};
        let end = null;
        let truncated = true;
        let pos = 32;
        let skippedPads = 0;
        const un = { v: { last: 0, wraps: 0 }, a: { last: 0, wraps: 0 } };
        const unwrap = (u, raw) => {
            if (raw < u.last - WRAP / 2) u.wraps++;
            u.last = raw;
            return raw + u.wraps * WRAP;
        };
        let lastProgress = 0;

        while (pos + 16 <= size) {
            const h = await reader.get(pos, 16);
            if (!h) break;
            const dv = new DataView(h.buffer, h.byteOffset, 16);
            const type = TYPES.get(dv.getUint32(0, true));
            if (!type) break; // a file that was cut off ends with whatever the SD card held
            const len = dv.getUint32(4, true);
            const rawT = dv.getUint32(8, true);
            const screenByte = h[12];
            const fmt = h[13];
            const cols = dv.getUint16(14, true);
            counts[type] = (counts[type] || 0) + 1;
            bytes[type] = (bytes[type] || 0) + len;

            if (type === 'E') {
                const t = rawT;
                let info = { framesTop: 0, framesBottom: 0, dropped: 0 };
                const pl = len >= 16 ? await reader.get(pos + 16, 16) : null;
                if (pl) {
                    const d2 = new DataView(pl.buffer, pl.byteOffset, 16);
                    info = { framesTop: d2.getUint32(0, true), framesBottom: d2.getUint32(4, true), dropped: d2.getUint32(8, true) };
                }
                end = { timeUs: t, ...info };
                truncated = false;
                break;
            }

            let next;
            if (type === 'P') {
                // "skip len bytes": normally the payload after the 16-byte header. If that does not land on a
                // record, fall back to len counting from the record's start, then to the next 16-byte boundary.
                const cands = [pos + 16 + len, pos + len, (pos + 16 + len + 15) & ~15];
                next = cands[0];
                for (const c of cands) {
                    const m = c + 4 <= size ? await reader.get(c, 4) : null;
                    if (m && TYPES.has(new DataView(m.buffer, m.byteOffset, 4).getUint32(0, true))) { next = c; break; }
                }
                skippedPads++;
            } else {
                next = pos + 16 + len + ((16 - (len % 16)) % 16);
                if (pos + 16 + len > size) break; // cut off in the middle of a payload
            }

            if (VIDEO_TYPES.includes(type)) {
                const screen = screenByte & 0x3f;
                if (screen <= 1 && cols > 0 && cols <= 800) {
                    video[screen].push({
                        type,
                        key: (screenByte & 0x40) !== 0 || type === 'Q' || type === 'C' || type === 'F',
                        t: unwrap(un.v, rawT),
                        cols,
                        off: pos + 16,
                        len,
                    });
                }
            } else if (type === 'A') {
                const n = cols; // stereo samples in this frame
                if (n > 0 && len >= n * 4) {
                    const pl = await reader.get(pos + 16, len);
                    if (pl) {
                        let counter = -1;
                        let flags = 0;
                        if (len >= n * 4 + 8) {
                            const o = n * 4;
                            const c0 = pl[o] | (pl[o + 1] << 8);
                            const c1 = pl[o + 2] | (pl[o + 3] << 8);
                            counter = fmt === 0 ? c0 : c1; // each frame carries its own DSP region's frame counter
                            flags = pl[o + 6] | (pl[o + 7] << 8);
                        }
                        if (!(flags & 2)) { // 2 = diagnostics raw read, not a real frame
                            audio.push({ t: unwrap(un.a, rawT), n, region: fmt, counter, flags, pcm: new Int16Array(pl.buffer.slice(pl.byteOffset, pl.byteOffset + n * 4)) });
                        }
                    }
                }
            }

            pos = next;
            if (onProgress && pos - lastProgress > 4 * 1024 * 1024) { lastProgress = pos; onProgress(pos / size); }
        }

        // length of the recording
        let lastT = 0;
        for (const s of video) if (s.length) lastT = Math.max(lastT, s[s.length - 1].t);
        if (audio.length) lastT = Math.max(lastT, audio[audio.length - 1].t);
        const durationUs = end ? Math.max(end.timeUs, 0) + (end.timeUs < lastT - WRAP / 2 ? WRAP : 0) : lastT;
        if (onProgress) onProgress(1);
        return { header, video, audio, end, truncated, counts, bytes, fileSize: size, durationUs: Math.max(durationUs, lastT), skippedPads };
    }

    /* ----------------------------------------------------------------------------- RGB565 -> RGBA */

    let LUT565 = null;
    function lut565() {
        if (LUT565) return LUT565;
        LUT565 = new Uint32Array(65536);
        for (let v = 0; v < 65536; v++) {
            const r5 = v >> 11, g6 = (v >> 5) & 63, b5 = v & 31;
            const r = (r5 << 3) | (r5 >> 2), g = (g6 << 2) | (g6 >> 4), b = (b5 << 3) | (b5 >> 2);
            LUT565[v] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0; // R,G,B,A in memory on little-endian
        }
        return LUT565;
    }

    /** Column-major RGB565 (word 0 = bottom row) -> row-major RGBA pixels in `out32` (cols x 240). */
    function frameToRGBA(frame, cols, out32) {
        const lut = lut565();
        for (let x = 0; x < cols; x++) {
            const base = x * ROWS;
            for (let y = 0; y < ROWS; y++) out32[y * cols + x] = lut[frame[base + ROWS - 1 - y]];
        }
    }

    /* --------------------------------------------------------------------------------------- codecs */

    /** XR32: XOR-RLE over pixel pairs. Tokens: t < 0x8000 -> t+1 unchanged pairs; else (t & 0x7FFF)+1 literal pairs. */
    function xr32Decode(src, frame, n, key) {
        if (n & 1) return false;
        const len = src.length;
        let pos = 0, i = 0;
        while (pos + 2 <= len) {
            const t = src[pos] | (src[pos + 1] << 8);
            pos += 2;
            const words = ((t & 0x7fff) + 1) * 2;
            if (i + words > n) return false;
            if (t & 0x8000) {
                if (pos + words * 2 > len) return false;
                if (key) for (let k = 0; k < words; k++, pos += 2) frame[i + k] = src[pos] | (src[pos + 1] << 8);
                else for (let k = 0; k < words; k++, pos += 2) frame[i + k] ^= src[pos] | (src[pos + 1] << 8);
            } else if (key) {
                frame.fill(0, i, i + words);
            }
            i += words;
        }
        return i === n;
    }

    /** XOR-RLE over single words. */
    function xrleDecode(src, frame, n, key) {
        const len = src.length;
        let pos = 0, i = 0;
        while (pos + 2 <= len) {
            const t = src[pos] | (src[pos + 1] << 8);
            pos += 2;
            const count = (t & 0x7fff) + 1;
            if (i + count > n) return false;
            if (t & 0x8000) {
                if (pos + count * 2 > len) return false;
                if (key) for (let k = 0; k < count; k++, pos += 2) frame[i + k] = src[pos] | (src[pos + 1] << 8);
                else for (let k = 0; k < count; k++, pos += 2) frame[i + k] ^= src[pos] | (src[pos + 1] << 8);
            } else if (key) {
                frame.fill(0, i, i + count);
            }
            i += count;
        }
        return i === n;
    }

    /** Q565: a QOI-style byte format for RGB565, one picture on its own. */
    const q565Index = new Uint16Array(64);
    function q565Decode(src, frame, n) {
        q565Index.fill(0);
        const len = src.length;
        let prev = 0, pos = 0, i = 0;
        while (i < n) {
            if (pos >= len) return false;
            const b = src[pos++];
            if (b === 0xfe) { // RAW
                if (pos + 2 > len) return false;
                prev = src[pos] | (src[pos + 1] << 8);
                pos += 2;
                q565Index[Math.imul(prev, 0x9e3779b1) >>> 26] = prev;
            } else if ((b & 0xc0) === 0xc0) { // RUN
                const k = (b & 0x3f) + 1;
                if (i + k > n) return false;
                frame.fill(prev, i, i + k);
                i += k;
                continue;
            } else if ((b & 0xc0) === 0) { // INDEX
                prev = q565Index[b];
            } else { // DIFF / LUMA
                let sr, sg, sb;
                if ((b & 0xc0) === 0x40) {
                    sr = ((b >> 4) & 3) - 2;
                    sg = ((b >> 2) & 3) - 2;
                    sb = (b & 3) - 2;
                } else {
                    if (pos >= len) return false;
                    const b2 = src[pos++];
                    sg = (b & 0x3f) - 32;
                    const half = ((sg + 32) >> 1) - 16;
                    sr = (b2 >> 4) - 8 + half;
                    sb = (b2 & 15) - 8 + half;
                }
                const r = ((prev >> 11) + sr) & 31;
                const g = (((prev >> 5) & 63) + sg) & 63;
                const bl = ((prev & 31) + sb) & 31;
                prev = (r << 11) | (g << 5) | bl;
                q565Index[Math.imul(prev, 0x9e3779b1) >>> 26] = prev;
            }
            frame[i++] = prev;
        }
        return true;
    }

    /** C420: lossy 4:2:0-style picture on its own, one 32-bit word per 2x2 block (see codec.h). */
    function c420Decode(src, frame, cols, rows) {
        if (((cols | rows) & 1) || src.length !== cols * rows) return false;
        const clamp = (v, max) => (v < 0 ? 0 : v > max ? max : v);
        let pos = 0;
        for (let c = 0; c < cols; c += 2) {
            const a = c * rows, b = a + rows;
            for (let r = 0; r < rows; r += 2, pos += 4) {
                const w = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
                const co = ((w >>> 20) & 63) - 32;
                const cg = (w >>> 26) - 32;
                const A = 2 * co - 2 * cg + 2;
                const B = -2 * co - 2 * cg + 2;
                const C = 2 * cg + 1;
                // s = 4y + 2 - o with ordered-dither offsets o = 0, 2, 2, 1
                let s = 4 * (w & 31) + 2;
                frame[a + r] = (clamp((s + A) >> 2, 31) << 11) | (clamp((s + C) >> 1, 63) << 5) | clamp((s + B) >> 2, 31);
                s = 4 * ((w >>> 5) & 31);
                frame[a + r + 1] = (clamp((s + A) >> 2, 31) << 11) | (clamp((s + C) >> 1, 63) << 5) | clamp((s + B) >> 2, 31);
                s = 4 * ((w >>> 10) & 31);
                frame[b + r] = (clamp((s + A) >> 2, 31) << 11) | (clamp((s + C) >> 1, 63) << 5) | clamp((s + B) >> 2, 31);
                s = 4 * ((w >>> 15) & 31) + 1;
                frame[b + r + 1] = (clamp((s + A) >> 2, 31) << 11) | (clamp((s + C) >> 1, 63) << 5) | clamp((s + B) >> 2, 31);
            }
        }
        return true;
    }

    /* Huffman stage (R3DH): two canonical codes (even / odd bytes), max 12 bits, LSB-first in little-endian u16s. */
    const HUFF_BITS = 12;
    const HUFF_HEADER = 4 + 256;
    const huffT0 = new Uint16Array(1 << HUFF_BITS);
    const huffT1 = new Uint16Array(1 << HUFF_BITS);
    const hLen = new Uint8Array(256);

    function huffBuildTable(src, off, table) {
        let kraft = 0;
        for (let k = 0; k < 128; k++) {
            const b = src[off + k];
            hLen[2 * k] = b & 15;
            hLen[2 * k + 1] = b >> 4;
        }
        const count = new Uint32Array(HUFF_BITS + 2);
        for (let s = 0; s < 256; s++) {
            const l = hLen[s];
            if (l > HUFF_BITS) return false;
            if (l) kraft += 1 << (HUFF_BITS - l);
            count[l]++;
        }
        if (kraft > 1 << HUFF_BITS) return false;
        count[0] = 0;
        const next = new Uint32Array(HUFF_BITS + 2);
        let c = 0;
        for (let b = 1; b <= HUFF_BITS; b++) {
            c = (c + count[b - 1]) << 1;
            next[b] = c;
        }
        table.fill(0);
        for (let s = 0; s < 256; s++) {
            const l = hLen[s];
            if (!l) continue;
            let v = next[l]++, r = 0;
            for (let k = 0; k < l; k++, v >>= 1) r = (r << 1) | (v & 1);
            const e = (s << 4) | l;
            for (let x = r; x < 1 << HUFF_BITS; x += 1 << l) table[x] = e;
        }
        return true;
    }

    /** Returns the decoded bytes (an XR32 stream), or null for a malformed stream. */
    function huffDecode(src) {
        const len = src.length;
        if (len < HUFF_HEADER) return null;
        const n = (src[0] | (src[1] << 8) | (src[2] << 16) | (src[3] << 24)) >>> 0;
        if (n > 1 << 24) return null;
        if (!huffBuildTable(src, 4, huffT0) || !huffBuildTable(src, 4 + 128, huffT1)) return null;
        const out = new Uint8Array(n);
        let p = HUFF_HEADER, acc = 0, nb = 0, zf = 0;
        const pairs = n >> 1;
        const mask = (1 << HUFF_BITS) - 1;
        for (let i = 0; i < pairs; i++) {
            for (let half = 0; half < 2; half++) {
                if (nb < 16) {
                    if (p + 2 <= len) { acc |= (src[p] | (src[p + 1] << 8)) << nb; p += 2; } else zf += 16;
                    nb += 16;
                }
                const e = (half ? huffT1 : huffT0)[acc & mask];
                const l = e & 15;
                if (!l) return null;
                acc >>>= l;
                nb -= l;
                out[2 * i + half] = e >> 4;
            }
            if (zf > 32) return null; // reading far past the end
        }
        if (n & 1) {
            if (nb < 16) {
                if (p + 2 <= len) { acc |= (src[p] | (src[p + 1] << 8)) << nb; p += 2; } else zf += 16;
                nb += 16;
            }
            const e = huffT0[acc & mask];
            if (!(e & 15)) return null;
            out[n - 1] = e >> 4;
            nb -= e & 15;
        }
        return out;
    }

    /* ----------------------------------------------------------------------------- screen decoder */

    /** Keeps one screen's current picture and applies records to it, in file order. */
    class ScreenDecoder {
        constructor() {
            this.cols = 0;
            this.frame = new Uint16Array(400 * ROWS);
            this.errors = 0;
        }
        /** @returns {boolean} true when the record decoded cleanly */
        apply(entry, payload) {
            const cols = entry.cols;
            const n = cols * ROWS;
            if (cols !== this.cols) { // the screen changed size: start from black
                this.cols = cols;
                this.frame.fill(0);
            }
            const f = this.frame;
            let ok;
            switch (entry.type) {
                case 'F':
                    ok = payload.length === n * 2;
                    if (ok) for (let i = 0, p = 0; i < n; i++, p += 2) f[i] = payload[p] | (payload[p + 1] << 8);
                    break;
                case 'X': ok = xrleDecode(payload, f, n, entry.key); break;
                case 'Y': ok = xr32Decode(payload, f, n, entry.key); break;
                case 'Q': ok = q565Decode(payload, f, n); break;
                case 'C': ok = c420Decode(payload, f, cols, ROWS); break;
                case 'H': {
                    const raw = huffDecode(payload);
                    ok = !!raw && xr32Decode(raw, f, n, entry.key);
                    break;
                }
                default: ok = false;
            }
            if (!ok) this.errors++;
            return ok;
        }
    }

    /* ------------------------------------------------------------------------------------- audio */

    const s16diff = (a, b) => (((a - b + 32768) & 0xffff) - 32768); // signed difference of two u16 counters

    /**
     * Places the audio frames on a continuous timeline and returns interleaved stereo Int16 samples at the
     * recording's native rate. Silence is not stored in the file, so gaps become silence.
     *
     * Every frame carries its DSP region's frame counter, which counts one per 160-sample frame, so a frame's
     * position is exact and independent of when the recorder happened to poll it. Two frames read in one poll
     * share a timestamp and may be stored in the wrong order; the counters put them right. The timestamps only
     * anchor the start and re-anchor after a break (a restarted DSP, a long pause).
     */
    function buildAudioTimeline(frames, rate, durationUs) {
        if (!frames.length || !rate) return { pcm: new Int16Array(0), samples: 0, reordered: 0, resyncs: 0, gaps: 0 };

        // 1. put frames that were read in the same poll into counter order
        const ordered = [];
        let reordered = 0;
        for (let i = 0; i < frames.length;) {
            let j = i + 1;
            while (j < frames.length && frames[j].t - frames[i].t <= 1000) j++;
            const group = frames.slice(i, j);
            if (group.length > 1 && group.every((f) => f.counter >= 0)) {
                const before = group.slice();
                group.sort((a, b) => s16diff(a.counter, b.counter));
                if (group.some((f, k) => f !== before[k])) reordered++;
            }
            for (const f of group) ordered.push(f);
            i = j;
        }

        // 2. positions in samples
        const tol = Math.round(rate * 0.1); // 100 ms of disagreement between counters and clock = a break
        const pos = new Array(ordered.length);
        let base = 0, resyncs = 0, gaps = 0;
        let prev = null, prevPos = 0, cu = 0;
        for (let k = 0; k < ordered.length; k++) {
            const f = ordered[k];
            const byTime = Math.max(0, Math.round((f.t * rate) / 1e6) - f.n); // frames are seen just after they were made
            let p;
            if (f.counter >= 0 && prev && prev.counter >= 0) {
                const d = s16diff(f.counter, prev.counter);
                if (d <= 0) { pos[k] = -1; continue; } // a duplicate (or the DSP counter went backwards): drop it
                cu += d;
                p = base + cu * f.n;
                if (Math.abs(p - byTime) > tol) { base += byTime - p; p = byTime; resyncs++; }
                if (d > 1) gaps++;
            } else if (f.counter >= 0) { // first frame
                cu = 0;
                base = byTime;
                p = byTime;
            } else { // no counter in this file: continue the previous frame, or follow the clock after a break
                const cont = prev ? prevPos + prev.n : byTime;
                p = Math.abs(cont - byTime) <= tol ? cont : byTime;
                if (p !== cont) resyncs++;
            }
            pos[k] = p;
            prev = f;
            prevPos = p;
        }

        // 3. lay them down
        let total = Math.ceil((durationUs * rate) / 1e6);
        for (let k = 0; k < ordered.length; k++) if (pos[k] >= 0) total = Math.max(total, pos[k] + ordered[k].n);
        const pcm = new Int16Array(total * 2);
        for (let k = 0; k < ordered.length; k++) if (pos[k] >= 0) pcm.set(ordered[k].pcm, pos[k] * 2);
        return { pcm, samples: total, reordered, resyncs, gaps };
    }

    /** Windowed-sinc resampler (Blackman window, 16 taps each side). Returns planar Float32 channels. */
    function resampleStereo(pcm, srcRate, dstRate) {
        const nIn = pcm.length >> 1;
        const nOut = Math.floor((nIn * dstRate) / srcRate);
        const K = 16, TAPS = 2 * K, PHASES = 1024;
        const fc = Math.min(1, dstRate / srcRate); // cutoff in source Nyquist units
        const table = new Float32Array((PHASES + 1) * TAPS);
        for (let p = 0; p <= PHASES; p++) {
            const frac = p / PHASES;
            let sum = 0;
            for (let t = 0; t < TAPS; t++) {
                const d = frac - (t - K + 1); // x - j
                const sinc = d === 0 ? fc : Math.sin(Math.PI * fc * d) / (Math.PI * d);
                const w = Math.abs(d) < K ? 0.42 + 0.5 * Math.cos((Math.PI * d) / K) + 0.08 * Math.cos((2 * Math.PI * d) / K) : 0;
                const v = sinc * w;
                table[p * TAPS + t] = v;
                sum += v;
            }
            for (let t = 0; t < TAPS; t++) table[p * TAPS + t] /= sum; // unity gain at DC for every phase
        }
        const padL = new Float32Array(nIn + 2 * K), padR = new Float32Array(nIn + 2 * K);
        for (let i = 0; i < nIn; i++) {
            padL[i + K] = pcm[2 * i] / 32768;
            padR[i + K] = pcm[2 * i + 1] / 32768;
        }
        const outL = new Float32Array(nOut), outR = new Float32Array(nOut);
        const step = srcRate / dstRate;
        for (let i = 0; i < nOut; i++) {
            const x = i * step;
            let i0 = Math.floor(x);
            let ph = Math.round((x - i0) * PHASES);
            const row = ph * TAPS;
            // sample j = i0 - K + 1 + t lives at pad index j + K = i0 + 1 + t
            const b = i0 + 1;
            let l = 0, r = 0;
            for (let t = 0; t < TAPS; t++) {
                const w = table[row + t];
                l += padL[b + t] * w;
                r += padR[b + t] * w;
            }
            outL[i] = l;
            outR[i] = r;
        }
        return { left: outL, right: outR, frames: nOut };
    }

    /* -------------------------------------------------------------------------------- sources */

    /** A source for a browser File / Blob. */
    function blobSource(blob) {
        return {
            size: blob.size,
            async read(off, len) {
                return new Uint8Array(await blob.slice(off, off + len).arrayBuffer());
            },
        };
    }

    /** A source for an in-memory Uint8Array / Buffer. */
    function bufferSource(buf) {
        // a plain Uint8Array view (a Node Buffer's slice() would share memory instead of copying)
        const u8 = buf instanceof Uint8Array ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
        return { size: u8.length, async read(off, len) { return u8.subarray(off, off + len); } };
    }

    /** Payload of a video entry, read through a (separate) WindowReader. */
    async function readPayload(reader, entry) {
        const p = await reader.get(entry.off, entry.len);
        if (!p) throw new R3DError('The file ended in the middle of a frame.');
        return p;
    }

    return {
        ROWS, TYPES, MODE_NAMES, R3DError,
        parseHeader, scan, WindowReader, readPayload,
        ScreenDecoder, frameToRGBA, lut565,
        xr32Decode, xrleDecode, q565Decode, c420Decode, huffDecode,
        buildAudioTimeline, resampleStereo,
        blobSource, bufferSource,
    };
});

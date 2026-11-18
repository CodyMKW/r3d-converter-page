/* app.js - page logic for the R3D to MP4 converter. Needs r3d.js and convert.js. */
(function () {
    'use strict';
    const R = window.R3D;
    const C = window.R3DConvert;
    const $ = (id) => document.getElementById(id);

    const els = {
        input: $('fileInput'), pick: $('pickBtn'), idleBottom: $('idleBottom'), btnA: $('btnA'), btnHome: $('btnHome'),
        swap: $('swapBtn'), errPick: $('errPick'),
        panel: $('panel'), blkFile: $('blkFile'), blkFacts: $('blkFacts'), blkNotes: $('blkNotes'), blkOptions: $('blkOptions'),
        blkActions: $('blkActions'), blkProgress: $('blkProgress'), blkResult: $('blkResult'), blkError: $('blkError'),
        fileName: $('fileName'), fileMeta: $('fileMeta'),
        fLength: $('fLength'), fDate: $('fDate'), fConsole: $('fConsole'), fScreens: $('fScreens'), fFps: $('fFps'), fSound: $('fSound'),
        sound: $('sound'), soundHelp: $('soundHelp'), estimate: $('estimate'),
        convert: $('convertBtn'), cancel: $('cancelBtn'), cancelRow: $('cancelRow'),
        progLabel: $('progLabel'), progText: $('progText'), meter: $('meter'), meterFill: $('meterFill'),
        video: $('video'), dl: $('dl'), again: $('againBtn'), resultStats: $('resultStats'), errText: $('errText'),
        led: $('led'), clock: $('clock'), veil: $('veil'), toast: $('toast'), depth: $('depth'),
        idleTop: $('idleTop'), topCanvas: $('topCanvas'), botCanvas: $('botCanvas'), topOff: $('topOff'), botOff: $('botOff'),
        scrubber: $('scrubber'), tNow: $('tNow'), tTotal: $('tTotal'),
        xbar: $('xbar'), xbarHelp: $('xbarHelp'), codecTable: $('codecTable'),
    };
    const ctx = [els.topCanvas.getContext('2d'), els.botCanvas.getContext('2d')];
    const canvases = [els.topCanvas, els.botCanvas];

    const state = { file: null, info: null, sum: null, player: null, busy: false, cancel: false, url: null, support: null, drawnRev: [-1, -1] };

    /* ------------------------------------------------------------------------------------ small helpers */

    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    function tickClock() {
        const d = new Date();
        const h = d.getHours() % 12 || 12;
        els.clock.textContent = `${d.getMonth() + 1}/${d.getDate()} (${DAYS[d.getDay()]}) ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    tickClock();
    setInterval(tickClock, 10000);

    let toastTimer = 0;
    function toast(msg) {
        els.toast.textContent = msg;
        els.toast.classList.add('on');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => els.toast.classList.remove('on'), 3200);
    }

    /** The hinge light, using the recorder's own codes: ready / busy / done / error. */
    function led(mode) {
        els.led.removeAttribute('data-led');
        void els.led.offsetWidth; // restart the animation
        if (mode) els.led.setAttribute('data-led', mode);
    }

    const checked = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
    const fmtTime = (ms) => C.formatDuration(ms / 1000);

    /* ------------------------------------------------------------------------------------- panel states */

    const VISIBLE = {
        empty: [],
        scanning: ['blkFile', 'blkProgress'],
        ready: ['blkFile', 'blkFacts', 'blkNotes', 'blkOptions', 'blkActions'],
        working: ['blkFile', 'blkFacts', 'blkProgress'],
        done: ['blkFile', 'blkFacts', 'blkNotes', 'blkResult'],
        error: ['blkFile', 'blkError'],
    };
    const BLOCKS = ['blkFile', 'blkFacts', 'blkNotes', 'blkOptions', 'blkActions', 'blkProgress', 'blkResult', 'blkError'];
    function setState(s) {
        els.panel.dataset.state = s;
        for (const id of BLOCKS) els[id].hidden = !VISIBLE[s].includes(id);
        if (s === 'ready' && !els.blkNotes.children.length) els.blkNotes.hidden = true;
        if (s === 'done' && !els.blkNotes.children.length) els.blkNotes.hidden = true;
        els.swap.hidden = s === 'scanning' || s === 'working';
        els.scrubber.disabled = !(s === 'ready' || s === 'done');
    }

    function setMeter(frac, label, text) {
        const pct = Math.round(frac * 100);
        els.meterFill.style.width = pct + '%';
        els.meter.setAttribute('aria-valuenow', String(pct));
        if (label) els.progLabel.textContent = label;
        els.progText.textContent = text !== undefined ? text : pct + '%';
    }

    function setNotes(list) {
        els.blkNotes.textContent = '';
        for (const n of list) {
            const li = document.createElement('li');
            li.textContent = n.text;
            if (n.bad) li.className = 'bad';
            els.blkNotes.appendChild(li);
        }
    }

    function fail(message) {
        els.errText.textContent = message;
        setState('error');
        led('error');
    }

    /* ----------------------------------------------------------------------------------------- preview */

    function showScreens(hasTop, hasBottom) {
        els.idleTop.hidden = true;
        els.idleBottom.hidden = true;
        els.topCanvas.hidden = !hasTop;
        els.topOff.hidden = hasTop;
        els.botCanvas.hidden = !hasBottom;
        els.botOff.hidden = hasBottom;
    }

    function showIdle() {
        els.idleTop.hidden = false;
        els.idleBottom.hidden = false;
        els.topCanvas.hidden = els.botCanvas.hidden = els.topOff.hidden = els.botOff.hidden = true;
    }

    function drawPreview(player) {
        player.render();
        for (let s = 0; s < 2; s++) {
            const img = player.images[s];
            if (!img || state.drawnRev[s] === player.rev[s]) continue;
            const cv = canvases[s];
            if (cv.width !== img.width) cv.width = img.width;
            ctx[s].putImageData(img, 0, 0);
            state.drawnRev[s] = player.rev[s];
        }
    }

    function setScrub(ms) {
        const max = +els.scrubber.max || 1;
        els.scrubber.value = String(Math.min(max, Math.round(ms)));
        els.scrubber.style.setProperty('--fill', (100 * ms) / max + '%');
        els.tNow.textContent = fmtTime(ms);
    }

    let seeking = false, pendingSeek = null;
    async function seekTo(ms) {
        pendingSeek = ms;
        if (seeking || !state.player) return;
        seeking = true;
        try {
            while (pendingSeek !== null) {
                const t = pendingSeek;
                pendingSeek = null;
                await state.player.seek(t * 1000);
                drawPreview(state.player);
            }
        } catch (e) {
            console.error(e);
        } finally {
            seeking = false;
        }
    }

    els.scrubber.addEventListener('input', () => {
        const ms = +els.scrubber.value;
        setScrub(ms);
        seekTo(ms);
    });

    /* --------------------------------------------------------------------------------------- open file */

    function pickFile() {
        if (state.busy) { toast('Finish or cancel the current conversion first.'); return; }
        els.input.click();
    }

    function ripple(ev, host) {
        if (!ev || !ev.clientX) return;
        const r = host.getBoundingClientRect();
        const dot = document.createElement('span');
        dot.className = 'tap';
        dot.style.left = ev.clientX - r.left + 'px';
        dot.style.top = ev.clientY - r.top + 'px';
        host.appendChild(dot);
        setTimeout(() => dot.remove(), 700);
    }

    async function openFile(file) {
        if (state.busy) { toast('Finish or cancel the current conversion first.'); return; }
        state.busy = true;
        if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
        els.video.removeAttribute('src');
        els.video.load();
        state.file = file;
        state.info = state.sum = state.player = null;
        state.drawnRev = [-1, -1];
        els.fileName.textContent = file.name;
        els.fileMeta.textContent = C.formatBytes(file.size);
        setNotes([]);
        els.cancelRow.hidden = true;
        setMeter(0, 'Reading the file', '0%');
        setState('scanning');
        led(null);
        try {
            if (!file.size) throw new R.R3DError('That file is empty.');
            const source = R.blobSource(file);
            const info = await R.scan(source, (f) => setMeter(f));
            const frames = info.video[0].length + info.video[1].length;
            if (!frames) {
                throw new R.R3DError(info.truncated
                    ? 'This recording has no picture in it. If the console lost power while recording, open 3DS Recorder on it once so it can recover the file, then copy the file again.'
                    : 'This recording has no picture in it.');
            }
            state.info = info;
            state.sum = C.summarize(info);
            state.player = new C.RecordingPlayer(source, info);
            await state.player.seek(0);
            showScreens(state.sum.hasTop, state.sum.hasBottom);
            drawPreview(state.player);
            populate();
            setState('ready');
            led('ready');
        } catch (e) {
            state.player = null;
            showIdle();
            const known = e instanceof R.R3DError;
            fail(known ? e.message : 'Could not read this file: ' + (e && e.message ? e.message : e));
        } finally {
            state.busy = false;
        }
    }

    /* ----------------------------------------------------------------------------- facts and options */

    function populate() {
        const sum = state.sum, info = state.info;
        els.fLength.textContent = C.formatDuration(sum.seconds);
        els.fDate.textContent = sum.date
            ? sum.date.toLocaleString(undefined, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) // the 3DS clock has no time zone
            : 'Unknown';
        els.fConsole.textContent = sum.console;
        els.fScreens.textContent = sum.hasTop && sum.hasBottom ? 'Both' : sum.hasTop ? 'Top only' : 'Bottom only';
        els.fFps.textContent = sum.fps + ' fps';
        els.fSound.textContent = sum.hasAudio ? C.formatDuration(sum.audioSeconds).replace(/^0:/, '') + ' s' : 'None';

        // scrubber
        const ms = Math.max(1, Math.round(info.durationUs / 1000));
        els.scrubber.max = String(ms);
        els.tTotal.textContent = fmtTime(ms);
        setScrub(0);

        // which screens can be exported
        const radios = document.querySelectorAll('input[name="layout"]');
        radios.forEach((r) => {
            const both = r.value === 'both';
            const ok = both ? sum.hasTop && sum.hasBottom : r.value === 'top' ? sum.hasTop : sum.hasBottom;
            r.disabled = !ok;
            r.checked = false;
        });
        const first = [...radios].find((r) => !r.disabled);
        if (first) first.checked = true;

        fillCodecTable();
        updateSupportUi();
    }

    function fillCodecTable() {
        const sum = state.sum;
        const total = sum.fileSize || 1;
        const rows = [...els.codecTable.querySelectorAll('tbody tr')];
        els.xbar.textContent = '';
        for (const tr of rows) {
            const type = tr.dataset.type;
            let frames = 0, bytes = 0, unit = 'frames';
            if (type === 'A') { frames = state.info.counts.A || 0; bytes = sum.audioBytes; unit = 'blocks'; }
            else { const c = sum.codecs.find((x) => x.type === type); if (c) { frames = c.frames; bytes = c.bytes; } }
            const cell = tr.lastElementChild;
            tr.classList.toggle('used', frames > 0);
            tr.classList.toggle('dim', frames === 0);
            cell.textContent = '';
            const a = document.createElement('span');
            a.textContent = frames ? `${frames.toLocaleString()} ${unit}` : 'none';
            cell.appendChild(a);
            if (frames) {
                const b = document.createElement('span');
                b.textContent = C.formatBytes(bytes);
                cell.appendChild(b);
            }
            if (frames) {
                const seg = document.createElement('span');
                seg.className = 'c-' + type;
                seg.style.flexGrow = String(bytes);
                seg.title = `${tr.firstElementChild.textContent}: ${C.formatBytes(bytes)}`;
                els.xbar.appendChild(seg);
            }
        }
        els.xbar.hidden = els.xbarHelp.hidden = false;
    }

    function readOpts() {
        return { layout: checked('layout'), scale: +checked('scale'), quality: checked('quality'), sound: els.sound.checked && !els.sound.disabled };
    }

    /** What this browser can encode, applied to the options and notes. */
    function updateSupportUi() {
        if (!state.sum) return;
        const sup = state.support;
        const sum = state.sum;
        const notes = [];
        if (sup && !sup.video) {
            notes.push({ bad: true, text: 'This browser cannot encode video, so it cannot make an MP4. Try a recent Chrome, Edge or Safari on a computer. You can still preview the recording here.' });
        }
        els.convert.disabled = !!(sup && !sup.video);

        const canSound = sum.hasAudio && !(sup && !sup.audio);
        els.sound.disabled = !canSound;
        if (!canSound) els.sound.checked = false;
        els.soundHelp.hidden = canSound;
        if (!sum.hasAudio) els.soundHelp.textContent = 'This recording has no sound.';
        else if (sup && !sup.audio) els.soundHelp.textContent = 'This browser cannot encode sound, so the MP4 will be silent.';
        if (canSound && sup && sup.audio === 'Opus') {
            notes.push({ text: 'This browser cannot encode AAC, so the sound will be saved as Opus. Most modern players handle it, but a few older ones will play the video without sound.' });
        }
        if (sup && sup.video && sup.video !== 'H.264') {
            notes.push({ text: `This browser cannot encode H.264, so the video will be ${sup.video}. It plays in browsers and most modern players, but not everywhere.` });
        }
        if (sum.cutOff) notes.push({ text: 'This recording was cut off before it was closed properly (power loss, a full SD card, or a copy that stopped early). It will convert as far as it goes.' });
        if (sum.dropped > 0) notes.push({ text: `The recorder reports ${sum.dropped} dropped frame${sum.dropped === 1 ? '' : 's'}, so some moments may look choppy.` });
        if (sum.version > 6) notes.push({ text: `This file is from a newer 3DS Recorder (format version ${sum.version}) than this page was written for. It may not convert correctly.` });
        setNotes(notes);
        els.blkNotes.hidden = !notes.length || !VISIBLE[els.panel.dataset.state].includes('blkNotes');
        updateEstimate();
    }

    function updateEstimate() {
        if (!state.info) return;
        const o = readOpts();
        const lay = C.layoutSize(state.info, o.layout);
        const w = lay.w * o.scale, h = lay.h * o.scale;
        const fps = state.sum.fps;
        const vbr = C.targetBitrate(lay.w, lay.h, fps, o.quality, o.scale);
        const sup = state.support;
        const abr = o.sound ? (sup && sup.audio === 'Opus' ? 128000 : 160000) : 0;
        const bytes = ((vbr + abr) * state.sum.seconds) / 8;
        const fmt = sup ? (sup.video ? sup.video + (o.sound && sup.audio ? ' + ' + sup.audio : '') : 'no encoder') : 'MP4';
        els.estimate.innerHTML = '';
        const s = document.createElement('span');
        s.textContent = `${w} × ${h}, ${fmt}, `;
        const b = document.createElement('strong');
        b.textContent = 'about ' + C.formatBytes(Math.max(bytes, 1)).replace(/^0 /, '1 ');
        els.estimate.append(s, b);
    }

    els.blkOptions.addEventListener('change', updateEstimate);

    /* ------------------------------------------------------------------------------------------ convert */

    function clearResult() {
        if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
        els.video.removeAttribute('src');
        els.video.load();
    }

    async function startConvert() {
        if (state.busy || !state.player) return;
        state.busy = true;
        state.cancel = false;
        clearResult();
        const opts = readOpts();
        const t0 = performance.now();
        els.cancelRow.hidden = false;
        setMeter(0, 'Starting', '0%');
        setState('working');
        led('busy');
        let result = null;
        try {
            result = await C.convert(state.player, opts, {
                cancelled: () => state.cancel,
                onStage: (s) => { els.progLabel.textContent = s; },
                onProgress: (f, x) => setMeter(f, null, x && x.frames ? `${Math.round(f * 100)}%  (frame ${x.frame} of ${x.frames})` : undefined),
                onPreview: (p, tUs) => { drawPreview(p); setScrub(Math.min(tUs / 1000, +els.scrubber.max)); },
            });
        } catch (e) {
            if (e && e.name === 'AbortError') {
                toast('Cancelled');
                setState('ready');
                led(null);
            } else {
                fail('The conversion stopped: ' + (e && e.message ? e.message : e));
            }
        }
        // the player ran to the end; go back to the start so the preview and scrubber are usable again
        try { state.player.reset(); await state.player.seek(0); drawPreview(state.player); setScrub(0); } catch (e) { /* preview only */ }
        state.busy = false;
        if (!result) return;

        state.url = URL.createObjectURL(result.blob);
        els.video.src = state.url;
        const base = state.file.name.replace(/\.[^.]*$/, '') || 'recording';
        els.dl.href = state.url;
        els.dl.download = base + '.mp4';
        const smaller = Math.max(0, Math.round(100 * (1 - result.blob.size / state.file.size)));
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        const parts = [];
        parts.push(`<strong>${C.formatBytes(result.blob.size)}</strong> from a ${C.formatBytes(state.file.size)} recording (${smaller}% smaller).`);
        parts.push(`${result.width} × ${result.height}, ${result.video}${result.audio ? ' + ' + result.audio : ', no sound'}, ${result.fps} fps. Took ${secs} s.`);
        els.resultStats.innerHTML = parts.join('<br>');
        const notes = [];
        if (result.decodeErrors) notes.push({ bad: true, text: `${result.decodeErrors} frame${result.decodeErrors === 1 ? ' was' : 's were'} damaged in the recording and could not be decoded; those moments may show an old picture.` });
        if (result.soundSkipped) notes.push({ text: 'The MP4 has no sound because this browser cannot encode it.' });
        setNotes(notes);
        setState('done');
        els.blkNotes.hidden = !notes.length;
        led('done');
    }

    /* ----------------------------------------------------------------------------------------- wiring */

    els.pick.addEventListener('click', pickFile);
    els.swap.addEventListener('click', pickFile);
    els.errPick.addEventListener('click', pickFile);
    els.btnA.addEventListener('click', pickFile);
    els.idleBottom.addEventListener('click', (e) => { ripple(e, document.getElementById('bottomScreen')); pickFile(); });
    els.btnHome.addEventListener('click', () => {
        const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
    });
    els.input.addEventListener('change', () => {
        const f = els.input.files && els.input.files[0];
        els.input.value = '';
        if (f) openFile(f);
    });
    els.convert.addEventListener('click', startConvert);
    els.cancel.addEventListener('click', () => { state.cancel = true; els.cancel.disabled = true; setTimeout(() => { els.cancel.disabled = false; }, 800); });
    els.again.addEventListener('click', () => { setState('ready'); els.blkNotes.hidden = !els.blkNotes.children.length; updateSupportUi(); });

    // drop a file anywhere
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; els.veil.classList.add('on'); } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) els.veil.classList.remove('on'); });
    window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        els.veil.classList.remove('on');
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) openFile(f);
    });

    // the depth slider only moves the title
    let joked = false;
    els.depth.addEventListener('input', () => {
        const v = +els.depth.value / 100;
        document.documentElement.style.setProperty('--depth', String(v));
        if (v > 0.96 && !joked) { joked = true; toast('Recordings are flat. This slider is for morale.'); }
    });

    // the recorder's "ready" blink, once, when the page opens
    setTimeout(() => led('ready'), 500);

    setState('empty');
    showIdle();
    if (C && C.probe) {
        C.probe().then((s) => { state.support = s; updateSupportUi(); }).catch(() => { state.support = { video: null, audio: null }; updateSupportUi(); });
    }
})();

# r3d-converter-page

A companion web page for [3DS Recorder](https://github.com/BolgarMaxym97/3ds-recorder).
Drop in a `.r3d` recording and get an MP4 back, the same job the 3DS does on the console.

Everything runs in the browser. The file is never uploaded anywhere.

## Using it

1. Copy the `.r3d` file from your 3DS SD card.
2. Open the page, then choose the file or drop it anywhere on the page.
3. Pick a layout, size and quality, then press Convert.
4. Download the MP4.

## Browser support

Conversion uses WebCodecs (`VideoEncoder` and `AudioEncoder`) and needs a secure context (HTTPS or localhost).
Current Chrome, Edge and Safari work. Firefox support depends on its version. The page checks what your browser can encode and tells you what it picked: H.264 if available, otherwise VP9 or AV1, and AAC audio if available, otherwise Opus.

## Hosting

It is a static site with no build step. Serve the folder as it is.

- **GitHub Pages:** Settings, Pages, deploy from branch `main`, folder `/ (root)`.
- **Nekoweb:** upload the folder contents.
- **Local:** `python3 -m http.server`, then open http://localhost:8000.

Opening `index.html` straight from disk will not work, because WebCodecs needs a secure context.

## Layout

- `js/r3d.js` parses the format and decodes all six video codecs plus audio (works in browsers and Node).
- `js/convert.js` composes frames, resamples audio and encodes the MP4.
- `js/app.js` is the page logic.
- `vendor/` holds mp4-muxer. `fonts/` holds the self-hosted typeface.

## Credits

The decoders are ported from 3DS Recorder by BolgarMaxym97. See [NOTICE.md](NOTICE.md) for third-party licenses.
This is an unofficial fan page and is not affiliated with Nintendo.

# Izakaya Yomi 読

Take a photo of a Japanese menu and see how to read every kanji, with furigana, romaji, English meanings and text-to-speech.

Everything runs on your device in the browser. After the first visit it works offline.

## How it works

1. **Text detection**: [PP-OCRv5 mobile](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx) finds lines of text, horizontal or vertical.
2. **Text recognition**: [PP-OCRv5 mobile rec](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx) reads each line. Vertical columns are rotated 90° first.
3. **Readings**: [kuromoji.js](https://github.com/takuyaa/kuromoji.js) splits the text into words and looks up their readings. It's helped by a small menu glossary (`src/glossary.js`) and by number handling for prices (880円 → はっぴゃくはちじゅうえん).

4. **Meanings**: [JMdict](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project) gives English meanings for each word. It also joins words into compounds the analyzer split, which fixes their readings (一夜 + 干し → 一夜干し, いちやぼし). Tap a meaning to see all of them.

Models run on [ONNX Runtime Web](https://onnxruntime.ai/), using WebGPU when available and WASM otherwise.

## Updating the dictionary

`dict/jmdict-eng.txt.gz` (6.5 MB) is generated from [jmdict-simplified](https://github.com/scriptin/jmdict-simplified/releases):

```sh
gh release download -R scriptin/jmdict-simplified -p 'jmdict-eng-[0-9]*.json.tgz'
tar xzf jmdict-eng-*.json.tgz
node scripts/build-jmdict.mjs jmdict-eng-*.json
```

Then bump `CACHE` in `sw.js`.

## Debugging

- `?ep=wasm` forces the CPU (WASM) backend instead of WebGPU.

## Known limitations

- The mobile recognition model sometimes misses rare kanji (for example 鰤 in some fonts). Heavily stylized calligraphy is hard too.
- Readings come from a general dictionary, so some menu-specific readings may be wrong. Add them to `src/glossary.js`.

## Licenses

- PP-OCRv5 models: Apache 2.0 (PaddlePaddle)
- ONNX Runtime Web: MIT (`vendor/ort/LICENSE`)
- kuromoji.js and its IPADIC dictionary: Apache 2.0 (`vendor/kuromoji/LICENSE-2.0.txt`)
- JMdict: © Electronic Dictionary Research and Development Group, [CC BY-SA 4.0](https://www.edrdg.org/edrdg/licence.html). `dict/jmdict-eng.txt.gz` is a modified (trimmed) version and is distributed under the same license.

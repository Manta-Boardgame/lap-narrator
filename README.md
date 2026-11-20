# lap-narrator

English | [日本語](README.ja.md)

lap-narrator is a toolset for turning a slide deck into a narrated video without touching the slides while you talk.

1. **On an Android phone**, you record the whole narration in one take. The only controls you need are **OK** (save point) and **retake**.
2. **On a PC**, the `narrate` command transcribes the recording (faster-whisper) and matches it against the script taken from the notes of your pptx. This decides where each slide starts and ends. Cuts the tool is not confident about are left to an LLM or a person.
3. It then builds an MP4 with **method A** (PowerPoint exports the video) or **method B** (PyAV builds it, no PowerPoint needed), and verifies the timing of the result.

The flow is: `pack` -> record on the phone -> `import` -> `status` -> `transcribe` -> `align` -> `render` -> `build` -> `verify`.

`narrate` asks no questions and prints exactly one JSON object to standard output, so it can be driven by a person or by an LLM. A cut it is unsure about stops with exit code 4 and waits for a decision.

## What is in this repository

- `app/`, `native/`, `android/` - the recording app (a web app, also packaged as an Android app with Capacitor).
- `cli/`, `core/`, `checker/`, `builder/` - the PC side: the `narrate` command (`cli/narrate.js`), alignment, rendering and video building.
- `schema/`, `examples/`, `testgen/`, `test/` - data formats, small synthetic samples, test-material generators and tests.
- `docs/` - the design document (`docs/design.md`, Japanese) and the PC setup guide (`docs/pc-setup.md`, Japanese).

Most comments and documents in this repository are written in Japanese. The app screen is English by default and can be switched to Japanese with the language button; the choice is remembered.

## Requirements

- Windows 11 (the only environment it has been run on; others are untested).
- Node.js 22 or later. `narrate` itself uses only the Node standard library.
- A Python virtual environment `.venv` with PyAV and NumPy (method B and `verify`) and faster-whisper (transcription): see `requirements-pc.txt` and `requirements-speech.txt`.
- The speech model `Systran/faster-whisper-small` (about 460 MB) in a local `models/` folder. `transcribe` uses only the models found there and never downloads one; if it is missing, the command stops with `speech-unavailable`.
- PowerPoint is needed only for method A and for `pack --from-pptx`.
- An Android phone to record on. Building the APK needs the Android SDK (see `native/` and `android/`).

PC setup is described in `docs/pc-setup.md` (Japanese). To check that a PC has everything:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\check-pc.ps1
```

Add `-PerSlide` if you use per-slide recording mode. Setting up a brand-new PC from scratch has not been tested.

## Getting started

Call the tool as `.\narrate.cmd <command> ...` or `node cli/narrate.js <command> ...` (written `narrate` below). The workspace (`--workspace`) is the folder that holds imported recordings and generated audio; it is created if it does not exist.

```
narrate pack --from-pptx deck.pptx --out script-pack.zip
narrate import <folder of the exported recording> --workspace ws
narrate status --workspace ws
narrate transcribe --workspace ws
narrate align --workspace ws
narrate render --workspace ws
narrate build --method B --workspace ws
narrate verify --workspace ws
```

1. **pack** makes a script pack (a zip with the script and the slide images) to put on the phone. Other inputs: `--from-json <folder>` and `--from-markdown deck.md --images <folder>`. `--from-pptx` needs PowerPoint.
2. **Record on the phone** with the app: read the script from start to finish; use only OK and retake. Export the recording and copy the zip (and `*_index.json`) to the PC. Loading a script pack in the app is optional.
3. **import** reads the export (zip files, `*_index.json`, or a folder). A recording made on another device can be imported with `import --audio recording.wav --script script-pack.zip --workspace ws` (16-bit mono PCM WAV at 8, 16, 44.1 or 48 kHz).
4. **status** shows the state without writing anything.
5. **transcribe** runs faster-whisper (model small, CPU) on `ws/final/all.wav` and writes word times to `ws/transcript.json`. The language is Japanese.
6. **align** matches the script to the transcript and writes `ws/boundaries.json`. If some cuts are not confident enough it stops with **exit code 4** and lists them.
7. **render** cuts the audio at the boundaries. It stops with exit code 4 while any cut still needs a decision.
8. **build** makes `ws/out/video.mp4` (`--method B`, or `--method A --pptx deck.pptx`).
9. **verify** measures how far the slide changes and audio starts in the video are from the timeline, and exits with code 3 if they are out of tolerance.

When `align` or `render` stops with exit code 4, read the transcript around the cut and decide with `narrate boundary confirm --slide <id>` or `narrate boundary set --slide <id> --at <seconds>`. Even when `align` succeeds, `narrate boundary review` prints the material to double-check every cut. Run `narrate --help` for all commands, the workflow order and the exit codes (0 success, 1 failure, 2 usage error, 3 verification mismatch, 4 decision needed). Optional loudness leveling (`--target-lufs`, `--ceiling-db`, `--lookahead-limiter`) and a lead-in length before each slide (`--lead-in-sec`) are options of `render`; see `README.ja.md` for details.

## Asking an AI to make the video

The app has a button, **Copy AI video-making prompt**, that copies an English instruction text to the clipboard. Give it to an AI on your PC that can read and write files and run commands, and it will follow the steps above. The text is `app/prompts/video-prompt.md`; it tells the AI to double-check every cut with `boundary review` and to avoid installing anything or sending data out.

## Privacy

- Your voice recordings stay on your devices. The recording stays on the phone until you export it, and the PC tools process it locally; the audio is never sent anywhere by this project.
- What an LLM sees is only what you give it: excerpts of the transcript text around the cuts it is asked to judge.
- The Android app does not request the INTERNET permission.
- `narrate` and the code in `cli/` and `core/` contain no network code.

## Not yet verified

- **Real human voices.** Transcription and boundary detection were checked only with synthetic speech. How the confidence behaves with real voices (noise, hesitation, dialect) is unknown; the default confidence threshold of 0.8 was chosen from synthetic-speech evaluation.
- **Long recordings.** Transcription time and memory for recordings over 30 minutes, and phone recording of 60 minutes or more, are unverified. Long screen-lock tests on the latest app version and battery-only tests were not done.
- **The latest Android build end to end**: loading a pack made from PowerPoint, recording, and importing on the PC in one continuous run has not been tested on a real device with the latest version. Clipboard copy of the AI prompt was checked on an emulator only.
- **Method A** (PowerPoint export) was checked with synthetic material; its MP4 audio was measured at 44.1 kHz and whether that is a PowerPoint specification is unknown. Setting up a new PC from scratch is untested.
- `edits.json` `limiter` from an export is not applied (`limiter-not-applied` warning); use `render --lookahead-limiter` on the PC. Audio in old-format ZIPs that is not 48 kHz cannot be converted by `render`. There is no `check` (audio inspection) command yet.
- Do not use one workspace from several `narrate` processes at the same time.

## Tests

```
npm test            # does not run PowerPoint
npm run test:cli
npm run test:app    # uses Chrome on the PC
npm run test:e2e    # needs Chrome and .venv
npm run test:native
```

Tests that include method A (`npm run test:builder`, `npm run test:all`) run PowerPoint. Many comments in the tests refer to internal development notes that are not part of this repository.

## License

MIT License. Copyright (c) 2026 Takahashi Raiki. See `LICENSE`. Third-party components used or required are listed in `THIRD_PARTY_NOTICES.md`; none of them is bundled in this repository.

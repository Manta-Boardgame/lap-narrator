# Third-party notices

lap-narrator itself is released under the MIT License (see `LICENSE`).

**This repository does not bundle any of the components below.** You install them yourself with `npm` or `pip`, or the Android build downloads them. The versions and licenses were read from the installed packages' own metadata (`package.json` / `*.dist-info/METADATA`) on the development machine. Check the license files shipped with each package for the authoritative text.

## Node.js packages (development and build tools; `npm install`)

| Package | Version | License | Source |
|---|---|---|---|
| @capacitor/core | 8.6.2 | MIT | https://capacitorjs.com |
| @capacitor/android | 8.6.2 | MIT | https://capacitorjs.com |
| @capacitor/cli | 8.6.2 | MIT | https://capacitorjs.com |
| pptxgenjs | 4.0.1 | MIT | https://gitbrent.github.io/PptxGenJS/ |
| playwright-core | 1.65.1 | Apache-2.0 | https://playwright.dev |
| typescript | 7.0.2 | Apache-2.0 | https://www.typescriptlang.org/ |

Transitive npm dependencies are listed in `package-lock.json`.

## Python packages (PC tools; `pip install -r requirements-pc.txt` / `requirements-speech.txt`)

| Package | Version | License | Source |
|---|---|---|---|
| faster-whisper | 1.2.1 | MIT | https://github.com/SYSTRAN/faster-whisper |
| ctranslate2 (dependency of faster-whisper) | 4.9.0 | MIT | https://github.com/OpenNMT/CTranslate2 |
| PyAV (`av`) | 19.0.2 | BSD-3-Clause | https://github.com/PyAV-Org/PyAV |
| numpy | 2.5.5 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | https://numpy.org |
| onnxruntime (dependency of faster-whisper) | 1.32.0 | MIT | https://onnxruntime.ai |
| tokenizers (dependency of faster-whisper) | 0.23.3 | Apache-2.0 (from the package classifier) | https://github.com/huggingface/tokenizers |
| huggingface_hub (dependency of faster-whisper) | 2.4.0 | Apache-2.0 | https://github.com/huggingface/huggingface_hub |

Other transitive Python dependencies (for example httpx, tqdm, PyYAML, protobuf, flatbuffers) are installed by pip with their own licenses; see each package's metadata.

### FFmpeg inside the PyAV wheel

The Windows wheel of PyAV bundles FFmpeg libraries (avcodec, avformat, avutil, swscale, and others) together with codec libraries. In the version checked here, the bundled libraries included libx264 and libx265, which are licensed under the GPL, besides LGPL-licensed FFmpeg components and BSD/other-licensed codecs such as libvpx, libdav1d, libopus and SVT-AV1. Because of this, a PyAV wheel installed from PyPI may be subject to LGPL and GPL terms for those binary components. lap-narrator does not redistribute them; if you redistribute a package that includes the PyAV wheel, you must follow those licenses.

## Speech recognition model (downloaded at run time, not included)

The `narrate` tool uses the `Systran/faster-whisper-small` model (CTranslate2 conversion of OpenAI Whisper "small"). The model files are downloaded by faster-whisper into a local `models/` folder and are not part of this repository.

License: OpenAI Whisper weights are MIT-licensed, and the Systran conversion is distributed on Hugging Face (https://huggingface.co/Systran/faster-whisper-small). **Not verified:** no model card or license file was present in the local model folder, so this statement comes from the upstream project's published information, not from a file checked on this machine. Please confirm on the Hugging Face model page.

## Android app (APK)

The APK built from `android/` includes the following libraries, which are resolved by Gradle at build time and are not stored in this repository:

| Component | Version | License |
|---|---|---|
| Capacitor Android runtime (`@capacitor/android`) | 8.6.2 | MIT |
| Apache Cordova Android framework (`org.apache.cordova:framework`, pulled in by Capacitor) | 14.0.1 | Apache-2.0 |
| AndroidX AppCompat | 1.7.1 | Apache-2.0 |
| AndroidX Activity | 1.11.0 | Apache-2.0 |
| AndroidX Core | 1.17.0 | Apache-2.0 |
| AndroidX Fragment | 1.8.9 | Apache-2.0 |
| AndroidX CoordinatorLayout | 1.3.0 | Apache-2.0 |
| AndroidX Core SplashScreen | 1.2.0 | Apache-2.0 |
| AndroidX WebKit | 1.14.0 | Apache-2.0 |

The Gradle wrapper (`android/gradle/wrapper/gradle-wrapper.jar`) is part of Gradle (Apache-2.0).

The AndroidX and Cordova licenses were not read from local files (the libraries are not stored here); they are the licenses these projects publish. The Android Gradle Plugin (8.13.0) is a build tool and is not part of the APK.

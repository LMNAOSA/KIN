# KIN 0.3 — Personal Communication Studio

A bespoke, experimental communication recogniser that can be taught by anyone with appropriate permission. It supports **one person per profile**, arbitrary message labels, **sound**, **human movement**, and **visual-scene** examples, as well as deliberately labelled **Ignore** signals. It is not a general AI that understands intent; it compares learned numerical patterns.

## Getting started

1. Unzip this archive and open Terminal inside `KIN-studio-v0.3`.
2. Run `python3 -m http.server 8080` (or `npm run start`).
3. In Chrome, Edge or Safari open **http://localhost:8080/**. Alternatively publish this folder as a static site using Vercel or another HTTPS host.
4. Choose **+ NEW** to create a completely blank profile for one person. Alternatively, **Example person** contains your four original gesture meanings, **untrained**.
5. In **02 / Teach KIN**, add an unlimited choice of words/phrases up to 90 signals per person. Choose the input type, set the person's own meaning, and add context.
6. Select that signal in the vocabulary. For a **sound**, start the microphone and record a three-second sample, or upload an audio recording. For a **movement**, start the camera and record a demonstration, or upload a movement video (e.g. one of the original four clips). For an **object / scene**, start the camera and record a visual view or upload a video.
7. Add **Ignore / not communication** samples: ordinary noises or unrelated movements/scenes. Learn at least **three independent examples each for two different signal labels within the same modality** to enable possible matches; ideally collect 15–30+ varied examples per class across separate days and settings, and reserve held-out recordings for testing.
8. Under **03 / Live translator**, start camera and/or microphone. A **possible** match is shown but **not spoken** until a communication partner presses **Confirm & Speak**. Dismiss incorrect suggestions; they are not treated as successful communications. Confirmed events go to the session history.
9. Export each person's profile to an individual JSON file (these include derived feature templates and **do not** include raw audio or video). Profile import creates a new profile rather than overwriting an existing one.

### Supported signal types

| Signal | How it works | Important limitations |
|---|---|---|
| Sound | Handcrafted time/frequency features, acoustic similarity on separate examples | Not speech-to-text or robust general environmental audio classification. Closely related grunts, whispers, short clicks and different microphones may be difficult. |
| Movement | Face, hand and body landmarks from MediaPipe and temporal signature comparison | Works only if body/hand/face landmarks are visible. It does not interpret fine or unusual movements well without further specialised models. |
| Visual scene | Whole-frame MobileNet image embeddings and similarity comparison | Useful to *experiment* with some scene/object classes, not guaranteed for arbitrary objects, objects in different backgrounds or moving actions. Can learn the background instead of the subject. |

### Architecture

- `index.html`, `styles.css`, `favicon.svg`: responsive interface.
- `app.js`: profile management, media capture, training flow, import/export, human-confirmed translation and in-memory session history.
- `recognition-core.js`: pure sound/visual-class matching, sequence features, ambiguity rejection, profile validation.
- `voice-recognition.js`: 3-part log-frequency audio descriptors.
- `sound-utils.js`: event trimming and an offline FFT to ingest short audio files.
- `tests`: unit tests. Run with `node --test` or `npm test`.
- Models used: Google MediaPipe Tasks Vision 1.2.2 Face Landmarker, Hand Landmarker, Pose Landmarker, and Image Embedder. First use of camera/vision downloads model assets from public CDNs. Internet is required for those assets; after loading, feature extraction runs in the browser. This is **not** a packaged offline application.
- Browser `localStorage` stores profiles and derived features. Clear browser storage to delete stored data on this device, or delete a profile through the application. There is no server/database, sign-in, synchronisation or clinical audit trail. Back up exported profiles securely.

### Known limitations / important safety notes

- **Recognition quality has not been verified on actual users.** Unit tests cover synthetic comparisons and profile sanitisation; they cannot prove field accuracy. Camera/microphone inference in Safari, Chrome, iOS and Android still needs device-specific verification. Example thresholds are provisional and might be inappropriate for an individual.
- The original four gesture clips provided the **meanings only**. They are not bundled or pre-trained in this build. Import videos into the corresponding visual labels or collect new live training examples.
- Separate profiles prevent template mixing inside the app. This is not a secure account-based identity system; local storage, exports and devices should be controlled appropriately. This prototype does not support multi-user camera tracking.
- A match is **not a probability and never proof of what a person intended**. Non-speech vocalisations and body signals may be context-dependent, discomfort-related, or ambiguous. Communicate and check meanings using the person's existing trusted methods.
- Partner approval is **not equivalent to consent** from the person communicating. Obtain informed or supported consent appropriate to their capacity and circumstances; include the communicator and familiar supporters in all meaning labels and validation.
- Keep reliable existing AAC, tactile signing, Braille, switch access or other communication methods available. This prototype is an **outgoing** communication tool only; it does not provide a tactile **incoming** channel for deafblind communicators. It must not be the only way to communicate distress, care needs, medical or emergency messages.
- This project has not undergone clinical testing, accessibility evaluation, security review or regulatory assessment and is **not a medical device**.
- Recording starts only after user interaction. Microphone and camera stop if the page is hidden. The application does not intentionally upload raw media to an application server, but public models/CDN assets are fetched and the MediaPipe SDK may send usage/diagnostic metrics to Google; assess the vendor's privacy terms before research involving vulnerable people.
- Uploading an audio/video file extracts descriptors only. Original files are **not** stored in profile exports. Sessions and any recorded communication logs are available only in memory until exported.

### Next build priorities

- Separate learner and operator interfaces, larger touch targets and screen reader testing.
- Collect and review *held-out* real-world samples; confusion matrices, per-person thresholds, false-positive measurement and train/test split controls.
- Optional external switch and tactile incoming communication, refreshable Braille integration.
- Secure, encrypted profile storage and consent controls, plus on-device offline model bundles.
- Better sound models (e.g. trainable audio embeddings) and more reliable fine-motion/eye-gaze tracking where required.

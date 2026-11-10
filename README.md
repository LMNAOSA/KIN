# KIN — gesture-to-communication prototype

**Version:** 0.1 — exploratory, non-clinical browser application.

KIN is a first functional prototype of an outgoing communication aid. The user makes one of four previously identified natural gestures; a camera-based recogniser displays the meaning for a communication partner and can speak it aloud. The first four mappings came from the four test videos supplied by the project creator:

| Gesture | Message |
| --- | --- |
| Fingers over mouth | No |
| Hand beneath chin | Yes |
| Hand covering eyes / upper face | Go away / not interested |
| Hand towards ear | Repeat / one more time |

**Important:** The four provided videos determined the *gesture meanings*, not a pre-trained ML classifier. The built-in **starter rules** use hand positions relative to face landmarks. To personalise the recogniser, use **Teach** to record camera landmark samples or import the supplied test videos individually under their corresponding labels. Video imports are processed locally in the browser and are not retained; only compact landmark feature vectors are stored in browser localStorage.

## Start locally

1. Unzip the project.
2. From the KIN-prototype directory, run one of:

   ```bash
   python3 -m http.server 8080
   ```

   or

   ```bash
   npx serve .
   ```

3. Open `http://localhost:8080/` in Chrome, Edge or Safari. The site includes a basic home-screen install manifest, but the ML models still require an internet connection on first use.
4. Choose **START CAMERA** and grant camera access. The first run downloads the MediaPipe JS runtime, WASM and face/hand models (requires internet).
5. Use **TEACH** to import the source videos or record more examples from the user's actual gesture performance. The app performs inference within the browser.
6. Hold a recognised gesture in view until the confirmation bar completes. Move your hand away to allow the next gesture.

Alternatively, deploy these static files on a HTTPS host (e.g. Vercel static). Camera capture typically needs a secure origin (HTTPS or localhost). **Do not open `index.html` directly with `file://`; use a local server.**

## Testing without a camera

Under Live > “The four starting cues”, select any preview button to demonstrate partner-facing output and optional speech. These are labelled manual previews and are **not** results from the camera.

## Training

- **TEACH WITH CAMERA:** live camera must be running. Hold the desired gesture for 3 seconds. At least five frames with face + hand must be visible.
- **VIDEO FILE:** import a short MP4/MOV/WebM clip for a given cue. Seventeen frames from the middle 70% of the video are sampled; face/hand landmark vectors are extracted. A minimum of three usable frames is required.
- **PROFILE:** export/import local feature templates as JSON. These templates contain landmark-derived spatial features and should still be handled as personal data.
- **SENSITIVITY:** the confirmation hold time can be set from 0.7–2.2 seconds. A score of 70% is **not** a calibrated probability or accuracy claim. The matching threshold and ambiguity margin are experimental design choices.

## Limitations and safety

- **Not validated for independent communication, clinical or safety-critical decisions.** Wrong matches or missed gestures are expected in this early prototype. Always maintain the person's established communication arrangements.
- **Outgoing only:** a partner receives visible and optionally spoken output, but this prototype provides no tactile reply pathway to a deafblind person.
- Requires usable head/hand visibility, camera placement, sufficient lighting and some sustained gesture movement. It is not suitable for every individual's motor or sensory abilities.
- The four starter patterns have not been trained on the actual four videos automatically. You must import those videos in the Teach panel if you want their gesture examples to inform recognition.
- ML recognition performance is unknown. Real-world validation requires recordings across users (if intended for multiple people), lighting, camera angles, neutral movements, deliberate gesture changes, repeated sessions and false-activation tests. Agree the gesture meanings and consent with the individual and carers.
- External CDN and Google model downloads are required at runtime. Raw webcam frames and imported videos are *processed locally* and are not intentionally uploaded by this application. MediaPipe’s SDK may send diagnostic/usage metrics according to its own privacy notice; investigate and configure deployment appropriately before sensitive use.
- The saved profile is stored in `localStorage` on the current device/browser. It is not encrypted and may be cleared by privacy settings. The session history is in memory and is not automatically persisted.
- No user accounts, cloud database, streaming, analytics, backend, or external speech transcription.

## Implementation

- Static HTML/CSS/JavaScript; no build step.
- MediaPipe Tasks Vision `@mediapipe/tasks-vision@1.2.2` (Apache-2.0), using the official Google hand and face landmark task files.
- `recognition.js` — face-relative feature extraction, simple anatomy-based starter classification, k-nearest reference sample similarities, temporal hold filter.
- `app.js` — camera UI and on-device ML execution, video upload ingestion, teaching, browser storage and CSV/JSON downloads.
- `styles.css` — responsive partner-facing UI.

### Next engineering steps

1. Controlled hold-out testing with signed-off reference labels and separate natural/no-gesture trials, recording false-positive rate and confusion matrix.
2. Model gestures as *time-series movements* (not just stable poses), and expose an explicit no-gesture class.
3. Replace rule + nearest-neighbour scoring with a per-person calibrated model and user-controlled confirmation mechanism.
4. Support tactile incoming communication and/or compatible Braille hardware; co-design with deafblind people and communication specialists.
5. Improve mobile performance (workers), offline use, accessibility, security, caregiver permissions and structured validation.

**KIN is a provisional working name; check trademark, domain and existing AAC product conflicts before releasing commercially.**

## Re-importing the four original test clips

The original videos are **not embedded in the app ZIP** to avoid accidentally publishing someone's face or private footage when deploying. A separate private reference-clips ZIP is supplied for calibration, if needed. In the Teach tab import:

| Cue | Filename |
| --- | --- |
| Repeat | `IMG_8182(1).mp4` |
| No | `IMG_8183(1).mp4` |
| Yes | `IMG_8184(1).mp4` |
| Go away | `IMG_8185(1).mp4` |

Do not deploy the reference-clips ZIP or its contents publicly.

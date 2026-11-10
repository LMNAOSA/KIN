# KIN — personal communication prototype (v0.5)

KIN learns user-labelled movement and sound signals to help people express messages. This is a supervised experimental prototype, **not** a validated assistive communication device or a replacement for existing AAC. Uncertain matches are not automatically spoken.

## Use it

```bash
python3 -m http.server 8080
```

Open http://localhost:8080 on a Mac. Deploy using HTTPS for camera and microphone permissions on iPhone and iPad. The MediaPipe models load over the internet. The application is a static site with no build step.

Choose **Movement** or **Sound**, then: (1) create messages, (2) teach each signal using multiple examples, and (3) test with a live view and a mapping/progress indicator. Movement teaching includes an on-screen framing guide and communication includes the tracked face/hand/pose overlay. The four starter rules exist only for the Example person; they are approximations, not verified meanings.

## Saved data — IndexedDB

KIN v0.5 uses the **IndexedDB** database named `kin-communication` with three stores:

| Store | Retains |
| --- | --- |
| `profiles` | A separate profile for each person, their named cues and per-cue sound or motion feature signatures |
| `meta` | Selected profile |
| `events` | Up to 500 confirmation/dismissal events (the person's profile, cue, timestamp, feedback) |

Existing v0.3 (`kin.studio.profiles.v3`) and v0.4 (`kin.personal.v4`) profiles are imported into IndexedDB the first time this version runs on **the same origin and browser**. Changes are saved after teaching, changing a message, importing/deleting a profile or selecting a person. Recognition events are logged separately for future evaluation. The application retains **derived feature signatures**, not raw audio or video, and does not upload data to an external service.

**Important:** IndexedDB is specific to one browser and origin. It persists between ordinary reloads, but may be cleared by private browsing, browser storage cleanup, device loss, or site data deletion. **Export profiles regularly.** This release does not yet sync across devices or users. It maintains the old localStorage key temporarily for rollback compatibility. Clear the old key after migration if privacy policy requires it.

## Optional future cloud database

`supabase/schema.sql` is a reviewed **starter schema**, not an active connection. It uses per-user ownership and row-level security, with no anonymous access. Do not run it against an unrelated project or publish a service-role key. A dedicated KIN project, login flow and a sync/conflict policy are still needed before cloud sync can be enabled. The currently connected Supabase projects are used for other work and have not been altered.

## Safety and privacy

- Get informed consent/appropriate supported agreement before recording. Include the communicator and trusted partners in deciding meanings.
- No personal training footage belongs in a public Git repository. `.gitignore` prevents *new* commits, but it does not remove media that is already committed. **The pre-existing `KIN-private-training-videos/` directory in this public repository contains the four original source videos and remains accessible through Git history.** The repo owner should make the repo private and plan a Git-history purge after securing an offline backup.
- The mapping bar indicates activity/hold progress, not statistical probability of an intended meaning.
- Do not rely on the app as the sole communication channel for medical or emergency needs.

## Tests

```bash
node --test
node --check app.js
node --check storage.js
```

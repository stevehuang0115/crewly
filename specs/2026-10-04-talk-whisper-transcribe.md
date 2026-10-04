# Talk: local Whisper transcription over the relay (#1074)

Part of epic #1073. Principle: **transcribe first, route second** — this
spec covers only turning the owner's voice into text on the owner's own
machine. Nothing is sent to an agent here; the text goes back to the phone,
the owner edits and confirms it, and only then does the existing Talk send
path run.

## Why

The portal Talk page (`crewlyai.com/portal/talk`, iPhone PWA) used the
phone's Web Speech recognizer. The owner mixes Chinese and English; Safari
heard Chinese as "Uncle". whisper.cpp large-v3-turbo on the owner's Mac does
a 7 s Chinese clip in 1.65 s and handles zh/en mixing. Cloud nodes (2 vCPU /
1 GB) cannot host it, so it runs on the machine of the agent being talked to.

## Flow

```
phone: hold → MediaRecorder (iOS: audio/mp4 AAC, Chrome: audio/webm opus)
  → release → base64 → relay api_request POST /talk/transcribe  (to that agent's machine)
machine: owner check → queue (1 at a time) → ffmpeg → 16 kHz mono WAV
  → whisper-cli -l auto --prompt "<zh bias + vocabulary>" -oj → text
  → api_response {text, language, durationSec, engine, deviceName}
phone: review box (edit / Send / Re-record / Cancel) — nothing sent without Send
```

## API (`/api/talk/transcribe`, all owner only)

| Route | Body | Answer |
|---|---|---|
| `GET /status` | — | `{ whisperReady, missing[], deviceName, busy, queued, maxDurationSec, maxAudioBytes, setup? }` |
| `POST /` | `{ audio: base64, mimeType, language?: auto\|zh\|en }` | `{ text, language, durationSec, engine: 'whisper.cpp', deviceName, elapsedMs }` |
| `POST /setup` | — | `{ state: running\|succeeded\|failed, jobId? }` (202 while running) |

Agents get 403 `owner_only`; callers without an owner credential 401
(`rejectNonOwner`). The relay presents the relay credential (`relay-owner`).
All three are on `MOBILE_API_ALLOWLIST`.

Errors (`{ success:false, code, error }`) — on any of them the phone falls back
to on-device Web Speech:

| code | HTTP | when |
|---|---|---|
| `whisper_unavailable` | 503 | ffmpeg, whisper-cli or the model is missing |
| `too_long` | 413 | > 640 KiB encoded or > 90 s decoded |
| `timeout` | 504 | the 45 s deadline (queue wait + ffmpeg + whisper) passed |
| `failed` | 500 | whisper-cli failed or produced nothing readable |
| `busy` | 429 | 3 requests already waiting |
| `invalid_audio` | 400 | bad base64, unknown type, or ffmpeg cannot decode it |

## Limits and why

- **Relay body cap 1 MiB** (`services/relay` `readBody`). The clip travels
  base64 (×4/3) inside a JSON string inside the send body, so the encoded
  audio is capped at **640 KiB** (≈ 853 KiB base64). The phone records AAC /
  opus at 32 kbps (≈ 4 KB/s), so 90 s ≈ 360 KB.
- **90 s duration.** The phone stops recording there; the machine decodes one
  second past the cap so an over-long clip is refused, not silently cut.
- **One at a time.** whisper uses most cores; at most 3 wait. One deadline of
  45 s covers the wait (under the portal's request timeout, so the phone
  gets a clean `timeout`).

## Engine

Same as the `transcribe-audio` skill (lookup order lifted from its
`execute.sh`): whisper-cli from `FLOPOST_WHISPER_BIN`, `~/.flopost/whisper/`,
`$CREWLY_HOME/bin`, PATH, Homebrew; model `ggml-large-v3-turbo-q5_0.bin` from
`FLOPOST_WHISPER_MODEL`, `~/.flopost/whisper/`, `~/.cache/whisper-models/`;
ffmpeg on the skill setup runner's search path. `POST /setup` runs that
skill's setup block through the install-job service (official skill, so
unattended).

Prompt: `以下是普通话的句子。` (Simplified Chinese bias) followed by the owner
glossary (`Crewly`, `CE`, …) and this machine's team, agent and project names,
bounded to 400 characters. Language `auto` by default.

## Privacy

- Audio is written to a private temp dir (`crewly-talk-stt-*`, mode 0600)
  and removed in `finally`; nothing is kept.
- Logs carry sizes, durations, language, character count and error codes —
  never audio or transcript text.
- In transit the clip sits in the Cloud relay queue (Mongo) until the machine
  acks it, like every relay message.

## Readiness

`talk_whisper` is added to the capabilities the machine reports to Cloud
(registry heartbeat + conversation sync) while Whisper is ready. Cloud's
`/instances` view does not return capabilities yet, so the portal reads
`GET /talk/transcribe/status` over the relay from the agent's machine.

## Not in this change

Talk-to-Crewly auto routing and the team picker (#1075, crewly-web#136 rest).

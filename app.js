const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const KEY_LAYOUT = [
  { key: "z", offset: 0 }, { key: "s", offset: 1 }, { key: "x", offset: 2 },
  { key: "d", offset: 3 }, { key: "c", offset: 4 }, { key: "v", offset: 5 },
  { key: "g", offset: 6 }, { key: "b", offset: 7 }, { key: "h", offset: 8 },
  { key: "n", offset: 9 }, { key: "j", offset: 10 }, { key: "m", offset: 11 },
  { key: "q", offset: 12 }, { key: "2", offset: 13 }, { key: "w", offset: 14 },
  { key: "3", offset: 15 }, { key: "e", offset: 16 }, { key: "r", offset: 17 },
  { key: "5", offset: 18 }, { key: "t", offset: 19 }, { key: "6", offset: 20 },
  { key: "y", offset: 21 }, { key: "7", offset: 22 }, { key: "u", offset: 23 },
];
const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);
const WHITE_NOTE_COUNT = 14;
const KEY_BY_CODE = new Map(KEY_LAYOUT.map(({ key, offset }) => [key, offset]));

const piano = document.querySelector("#piano");
const noteName = document.querySelector("#note-name");
const octaveLabel = document.querySelector("#octave-label");
const audioStatus = document.querySelector(".audio-status");
const audioStatusText = document.querySelector("#audio-status-text");
const midiButton = document.querySelector("#midi-connect");
const midiStatus = document.querySelector("#midi-status");
const waveformControl = document.querySelector("#waveform");
const volumeControl = document.querySelector("#volume");
const detuneControl = document.querySelector("#detune");
const canvas = document.querySelector("#visualizer");
const canvasContext = canvas.getContext("2d");

let baseMidiNote = 48;
let audioContext;
let masterGain;
let analyser;
let midiAccess;
let activeMidiInputs = new Set();
const voices = new Map();
const heldKeys = new Set();
const keyElements = new Map();
const midiSources = new Map();

function noteNameFor(midiNote) {
  return `${NOTE_NAMES[midiNote % 12]}${Math.floor(midiNote / 12) - 1}`;
}

function updateOctaveLabel() {
  octaveLabel.textContent = `${noteNameFor(baseMidiNote)} — ${noteNameFor(baseMidiNote + 23)}`;
}

function renderKeyboard() {
  piano.replaceChildren();
  keyElements.clear();
  const keys = KEY_LAYOUT.map(({ key, offset }) => {
    const midiNote = baseMidiNote + offset;
    const isBlack = BLACK_NOTES.has(offset % 12);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `piano-key ${isBlack ? "black" : "white"}`;
    button.dataset.note = String(midiNote);
    button.setAttribute("aria-label", `${noteNameFor(midiNote)} を演奏 (${key.toUpperCase()}キー)`);
    button.innerHTML = `<span class="key-label">${key.toUpperCase()}</span>`;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      startVoice(`pointer:${event.pointerId}`, midiNote);
    });
    button.addEventListener("pointerup", (event) => stopVoice(`pointer:${event.pointerId}`));
    button.addEventListener("pointercancel", (event) => stopVoice(`pointer:${event.pointerId}`));
    button.addEventListener("lostpointercapture", (event) => stopVoice(`pointer:${event.pointerId}`));
    keyElements.set(midiNote, button);
    return { button, isBlack, offset };
  });

  let precedingWhiteKeys = 0;
  for (const key of keys) {
    if (!key.isBlack) {
      piano.append(key.button);
      precedingWhiteKeys += 1;
      continue;
    }
    const position = precedingWhiteKeys / WHITE_NOTE_COUNT;
    key.button.style.position = "absolute";
    key.button.style.left = `calc(${position * 100}% - 2.65%)`;
    piano.append(key.button);
  }
  updateOctaveLabel();
  refreshActiveKeys();
}

function refreshActiveKeys() {
  for (const [midiNote, button] of keyElements) {
    const isActive = [...voices.values()].some((voice) => voice.midiNote === midiNote);
    button.classList.toggle("active", isActive);
  }
  const soundingNotes = [...voices.values()].map((voice) => voice.midiNote);
  noteName.textContent = soundingNotes.length ? noteNameFor(soundingNotes[soundingNotes.length - 1]) : "—";
  audioStatus.classList.toggle("is-playing", soundingNotes.length > 0);
  audioStatusText.textContent = soundingNotes.length ? "SOUND ON" : "READY TO PLAY";
}

function ensureAudio() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      midiStatus.textContent = "このブラウザはWeb Audioに対応していません。";
      throw new Error("Web Audio is not supported by this browser.");
    }
    audioContext = new AudioContextClass();
    masterGain = audioContext.createGain();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;
    masterGain.gain.value = Number(volumeControl.value) / 100 * 0.22;
    masterGain.connect(analyser);
    analyser.connect(audioContext.destination);
    drawVisualizer();
  }
  if (audioContext.state === "suspended") void audioContext.resume();
}

function startVoice(source, midiNote, velocity = 0.8) {
  if (voices.has(source)) return;
  ensureAudio();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = waveformControl.value;
  oscillator.frequency.value = 440 * 2 ** ((midiNote - 69) / 12);
  oscillator.detune.value = Number(detuneControl.value);
  const now = audioContext.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, velocity), now + 0.018);
  oscillator.connect(gain);
  gain.connect(masterGain);
  oscillator.start(now);
  voices.set(source, { oscillator, gain, midiNote });
  refreshActiveKeys();
}

function stopVoice(source) {
  const voice = voices.get(source);
  if (!voice) return;
  voices.delete(source);
  const now = audioContext.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setTargetAtTime(0.0001, now, 0.045);
  voice.oscillator.stop(now + 0.25);
  voice.oscillator.addEventListener("ended", () => {
    voice.oscillator.disconnect();
    voice.gain.disconnect();
  }, { once: true });
  refreshActiveKeys();
}

function drawVisualizer() {
  if (!analyser) return;
  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(bounds.width * pixelRatio));
  const height = Math.max(1, Math.round(bounds.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  canvasContext.clearRect(0, 0, width, height);
  canvasContext.lineWidth = pixelRatio * 1.5;
  canvasContext.strokeStyle = "#6fe4d2";
  canvasContext.shadowColor = "rgba(111, 228, 210, .45)";
  canvasContext.shadowBlur = 8 * pixelRatio;
  canvasContext.beginPath();
  const centerY = height / 2;
  for (let i = 0; i < samples.length; i += 1) {
    const x = (i / (samples.length - 1)) * width;
    const amplitude = ((samples[i] - 128) / 128) * height * 0.37;
    const y = centerY + amplitude;
    if (i === 0) canvasContext.moveTo(x, y);
    else canvasContext.lineTo(x, y);
  }
  canvasContext.stroke();
  canvasContext.shadowBlur = 0;
  requestAnimationFrame(drawVisualizer);
}

function isTypingTarget(target) {
  return target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
}

document.addEventListener("keydown", (event) => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
  const offset = KEY_BY_CODE.get(event.key.toLowerCase());
  if (offset === undefined) return;
  event.preventDefault();
  heldKeys.add(event.key.toLowerCase());
  startVoice(`keyboard:${event.key.toLowerCase()}`, baseMidiNote + offset);
});

document.addEventListener("keyup", (event) => {
  const key = event.key.toLowerCase();
  if (!heldKeys.delete(key)) return;
  stopVoice(`keyboard:${key}`);
});

window.addEventListener("blur", () => {
  for (const key of heldKeys) stopVoice(`keyboard:${key}`);
  heldKeys.clear();
});

document.querySelector("#octave-down").addEventListener("click", () => {
  if (baseMidiNote > 24) {
    baseMidiNote -= 12;
    renderKeyboard();
  }
});

document.querySelector("#octave-up").addEventListener("click", () => {
  if (baseMidiNote < 84) {
    baseMidiNote += 12;
    renderKeyboard();
  }
});

waveformControl.addEventListener("change", () => {
  for (const voice of voices.values()) voice.oscillator.type = waveformControl.value;
});

volumeControl.addEventListener("input", () => {
  const value = Number(volumeControl.value);
  document.querySelector("#volume-value").textContent = `${value}%`;
  volumeControl.style.setProperty("--range-progress", `${value}%`);
  if (masterGain && audioContext) {
    masterGain.gain.setTargetAtTime(value / 100 * 0.22, audioContext.currentTime, 0.015);
  }
});

detuneControl.addEventListener("input", () => {
  const value = Number(detuneControl.value);
  document.querySelector("#detune-value").textContent = `${value} ct`;
  detuneControl.style.setProperty("--range-progress", `${((value + 50) / 100) * 100}%`);
  if (audioContext) {
    for (const voice of voices.values()) {
      voice.oscillator.detune.setTargetAtTime(value, audioContext.currentTime, 0.015);
    }
  }
});

async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    midiStatus.textContent = "このブラウザはWeb MIDIに対応していません。ChromeまたはEdgeをご利用ください。";
    return;
  }
  midiButton.disabled = true;
  midiStatus.textContent = "MIDI機器を確認しています…";
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    midiAccess.onstatechange = updateMidiInputs;
    updateMidiInputs();
  } catch (error) {
    midiStatus.textContent = error.name === "NotAllowedError"
      ? "MIDIへのアクセスが許可されませんでした。ブラウザの設定を確認してください。"
      : `MIDIに接続できませんでした: ${error.message}`;
  } finally {
    midiButton.disabled = false;
  }
}

function updateMidiInputs() {
  if (!midiAccess) return;
  const connectedInputs = new Set([...midiAccess.inputs.values()].filter((input) => input.state === "connected"));
  for (const input of activeMidiInputs) {
    if (connectedInputs.has(input)) continue;
    input.onmidimessage = null;
    for (const [source, midiNote] of midiSources) {
      if (!source.startsWith(`${input.id}:`)) continue;
      stopVoice(source);
      midiSources.delete(source);
    }
  }
  for (const input of connectedInputs) {
    if (activeMidiInputs.has(input)) continue;
    input.onmidimessage = (event) => handleMidiMessage(input, event);
  }
  activeMidiInputs = connectedInputs;
  const count = connectedInputs.size;
  midiButton.classList.toggle("is-connected", count > 0);
  midiButton.innerHTML = count
    ? `<span class="midi-button-dot"></span> MIDI接続中 (${count}) <span aria-hidden="true">↗</span>`
    : `<span class="midi-button-dot"></span> MIDIを接続 <span aria-hidden="true">↗</span>`;
  midiStatus.textContent = count
    ? `${count}台のMIDI機器が接続されています。キーボードを弾いてください。`
    : "MIDIアクセスを許可しました。機器を接続すると自動で認識します。";
}

function handleMidiMessage(input, event) {
  const [status, note, velocity] = event.data;
  const command = status & 0xf0;
  const channel = status & 0x0f;
  const source = `${input.id}:${channel}:${note}`;
  if (command === 0x90 && velocity > 0) {
    if (midiSources.has(source)) stopVoice(source);
    midiSources.set(source, note);
    startVoice(source, note, velocity / 127 * 0.8);
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    midiSources.delete(source);
    stopVoice(source);
  }
}

midiButton.addEventListener("click", connectMidi);
volumeControl.dispatchEvent(new Event("input"));
detuneControl.dispatchEvent(new Event("input"));
renderKeyboard();

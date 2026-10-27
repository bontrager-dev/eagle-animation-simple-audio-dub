// Sends the mic samples, with the context frame of their first sample, in blocks of 2048
const CAPTURE_WORKLET = `
class DubCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.filled = 0;
    this.firstFrame = 0;
  }
  process(inputs) {
    const channels = inputs[0] || [];
    if (channels.length) {
      const size = channels[0].length;
      for (let i = 0; i < size; i++) {
        if (this.filled === 0) this.firstFrame = currentFrame + i;
        let value = 0;
        for (const channel of channels) value += channel[i];
        this.block[this.filled++] = value / channels.length;
        if (this.filled === this.block.length) {
          this.port.postMessage({ frame: this.firstFrame, samples: this.block }, [this.block.buffer]);
          this.block = new Float32Array(2048);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('dub-capture', DubCapture);
`;

import { groupExportedFrames, renderDubAudio } from './dubbing';
import { encodeWav } from './wav';

// Decoded take (mono, resampled to the context rate)
const fetchTake = async (context, projectId, trackId, filename) => {
  const data = await window.EA('GET_AUDIO', { project_id: projectId, track_id: trackId, filename });
  if (!data) {
    return null;
  }
  const bytes = new Uint8Array(data);
  const decoded = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return decoded.getChannelData(0);
};

// WAV of the dubbed sound under the exported frames (one entry per video frame)
export const renderExportAudio = async ({ projectId, trackId, exportedFrames, pictures, fps, sampleRate = 48000 }) => {
  const frames = groupExportedFrames(exportedFrames, pictures);
  const context = new OfflineAudioContext(1, 1, sampleRate);
  const filenames = [...new Set(frames.filter((f) => f.audio).map((f) => f.audio.filename))];
  const takes = new Map();
  for (const filename of filenames) {
    takes.set(filename, await fetchTake(context, projectId, trackId, filename).catch(() => null));
  }
  return encodeWav(renderDubAudio({ frames, fps, sampleRate, getSamples: (filename) => takes.get(filename) || null }), sampleRate);
};

// Audio kept before a take starts, so latency compensation can reach slightly into the past
const PRE_ROLL_SECONDS = 1;

export class DubAudio {
  constructor() {
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.sampleRate = this.context.sampleRate;
    this.takes = new Map();
    this.chunks = [];
    this.lastFrame = 0;
    this.level = 0;
    this.micReady = false;
    this.deviceId = null;
    this.openCount = 0;
    this.inputLatency = 0;
    this.takeStart = null;
    this.source = null;
    this.playStart = null;
  }

  // Opens a microphone, or switches to another one; no deviceId means the system default
  async openMicrophone(deviceId = null) {
    const openId = ++this.openCount;
    this.closeMicrophone();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (!this.workletLoaded) {
      const moduleUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
      this.workletLoaded = this.context.audioWorklet.addModule(moduleUrl).finally(() => URL.revokeObjectURL(moduleUrl));
    }
    await this.workletLoaded;
    // A newer call (the user picked another device meanwhile) wins
    if (openId !== this.openCount) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    this.stream = stream;
    this.input = this.context.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.context, 'dub-capture', { numberOfOutputs: 1, outputChannelCount: [1] });
    this.capture.port.onmessage = (event) => this.handleChunk(event.data);

    // The capture node has to reach the destination to be processed; the gain keeps it silent
    this.mute = this.context.createGain();
    this.mute.gain.value = 0;
    this.input.connect(this.capture).connect(this.mute).connect(this.context.destination);

    const trackSettings = this.stream.getAudioTracks()[0]?.getSettings() || {};
    this.inputLatency = Number(trackSettings.latency) || 0;
    this.deviceId = trackSettings.deviceId || deviceId;
    this.micReady = true;
  }

  closeMicrophone() {
    this.micReady = false;
    if (this.capture) {
      this.capture.port.onmessage = null;
    }
    [this.input, this.capture, this.mute].forEach((node) => node?.disconnect());
    this.stream?.getTracks().forEach((track) => track.stop());
    this.input = null;
    this.capture = null;
    this.mute = null;
    this.stream = null;
    this.chunks = [];
    this.level = 0;
  }

  resume() {
    return this.context.state === 'suspended' ? this.context.resume() : Promise.resolve();
  }

  handleChunk({ frame, samples }) {
    this.chunks.push({ frame, samples });
    this.lastFrame = frame + samples.length;
    this.level = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

    const keepFrom = this.takeStart !== null ? this.takeStart : this.lastFrame - PRE_ROLL_SECONDS * this.sampleRate;
    while (this.chunks.length && this.chunks[0].frame + this.chunks[0].samples.length < keepFrom) {
      this.chunks.shift();
    }
  }

  // Context time (seconds) of what the speakers play at a performance.now() moment
  outputTimeAt(perfTime) {
    const stamp = this.context.getOutputTimestamp ? this.context.getOutputTimestamp() : null;
    if (stamp && stamp.performanceTime > 0) {
      return stamp.contextTime + (perfTime - stamp.performanceTime) / 1000;
    }
    const outputLatency = (this.context.baseLatency || 0) + (this.context.outputLatency || 0);
    return this.context.currentTime - outputLatency + (perfTime - performance.now()) / 1000;
  }

  // Context frame of the mic sample that captured the sound made at a performance.now() moment.
  // Input is processed ahead of what the speakers play, by the output latency, and arrives late by the input latency.
  captureFrameAt(perfTime) {
    const outputLatency = (this.context.baseLatency || 0) + (this.context.outputLatency || 0);
    return Math.round((this.outputTimeAt(perfTime) + outputLatency + this.inputLatency) * this.sampleRate);
  }

  startTake(perfTime) {
    this.takeStart = this.captureFrameAt(perfTime);
  }

  // Seconds into the current take at a performance.now() moment
  takePosition(perfTime) {
    return this.takeStart === null ? 0 : (this.captureFrameAt(perfTime) - this.takeStart) / this.sampleRate;
  }

  // Waits for the mic to deliver everything up to the release, then returns the take samples
  async finishTake(perfTime) {
    if (!this.micReady) {
      this.takeStart = null;
      return null;
    }
    const start = this.takeStart;
    const end = Math.max(start, this.captureFrameAt(perfTime));
    const deadline = performance.now() + 1000;
    while (this.lastFrame < end && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const samples = new Float32Array(end - start);
    for (const chunk of this.chunks) {
      const from = Math.max(start, chunk.frame);
      const to = Math.min(end, chunk.frame + chunk.samples.length);
      if (to > from) {
        samples.set(chunk.samples.subarray(from - chunk.frame, to - chunk.frame), from - start);
      }
    }
    this.takeStart = null;
    return samples;
  }

  cancelTake() {
    this.takeStart = null;
  }

  // Decoded take (mono, at the context rate), cached by filename
  async loadTake(projectId, trackId, filename) {
    if (!this.takes.has(filename)) {
      this.takes.set(
        filename,
        fetchTake(this.context, projectId, trackId, filename).catch(() => null)
      );
    }
    return this.takes.get(filename);
  }

  setTake(filename, samples) {
    this.takes.set(filename, Promise.resolve(samples));
  }

  play(samples) {
    this.stop();
    const buffer = this.context.createBuffer(1, Math.max(1, samples.length), this.sampleRate);
    buffer.copyToChannel(samples, 0);
    this.source = this.context.createBufferSource();
    this.source.buffer = buffer;
    this.source.connect(this.context.destination);
    // A short lead makes the start time exact instead of "as soon as possible"
    this.playStart = this.context.currentTime + 0.05;
    this.source.start(this.playStart);
  }

  stop() {
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
    this.playStart = null;
  }

  // Seconds of the playing buffer heard at a performance.now() moment
  playPosition(perfTime) {
    return this.playStart === null ? 0 : Math.max(0, this.outputTimeAt(perfTime) - this.playStart);
  }

  close() {
    this.stop();
    this.openCount++;
    this.closeMicrophone();
    this.context.close();
  }
}

// A take shorter than this, without any frame step, is treated as an accidental tap
export const MIN_TAKE_DURATION = 0.25;

// Fade applied where two unrelated audio slices meet, to avoid clicks
const SEAM_FADE_DURATION = 0.004;

// Frames the dubbing view walks through: the ones that are played and exported
export const getDubFrames = (pictures = []) => pictures.filter((p) => !p.deleted && !p.hidden);

export const hasDubAudio = (pictures = []) => getDubFrames(pictures).some((p) => !!p.audio);

// Start tick of each frame, plus the total length as the last entry
export const getFrameStarts = (frames = []) => frames.reduce((acc, frame) => [...acc, acc[acc.length - 1] + (frame.length || 1)], [0]);

// Frame shown at a given tick
export const getFrameIndexAtTick = (starts, tick) => {
  let low = 0;
  let high = Math.max(0, starts.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= tick) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

// Turns a take into frame changes. `steps` are the seconds (from the take start) at which the next
// frame was shown and `end` is when record was released. Frame boundaries snap to the scene ticks,
// and the take audio is laid on the same ticks, so sound and pictures stay aligned.
export const computeTakeChanges = ({ frames = [], startIndex = 0, steps = [], end = 0, fps = 12, filename = null }) => {
  const toTick = (seconds) => Math.round(seconds * fps);
  const makeChange = (frame, fromTick, toTickValue) => ({
    id: frame.id,
    length: toTickValue - fromTick,
    audio: filename ? { filename, offset: fromTick / fps, duration: (toTickValue - fromTick) / fps } : null,
  });

  const changes = [];
  let index = startIndex;
  let startTick = 0;
  for (const step of steps) {
    if (index >= frames.length - 1) {
      break;
    }
    // A frame lasts at least one tick, so very fast steps push later frames back a little
    const tick = Math.max(startTick + 1, toTick(step));
    changes.push(makeChange(frames[index], startTick, tick));
    index++;
    startTick = tick;
  }

  // A frame reached just before release has not been recorded yet and stays untouched
  const endTick = toTick(end);
  if (frames[index] && endTick > startTick) {
    changes.push(makeChange(frames[index], startTick, endTick));
  }
  return changes;
};

const isContinuation = (previous, audio) => !!previous && !!audio && previous.filename === audio.filename && Math.abs(previous.offset + previous.duration - audio.offset) < 0.0005 && previous.complete;

const fadeSeam = (output, at, fadeLength) => {
  for (let i = 0; i < fadeLength && at + i < output.length; i++) {
    output[at + i] *= i / fadeLength;
  }
  for (let i = 1; i <= fadeLength && at - i >= 0; i++) {
    output[at - i] *= (i - 1) / fadeLength;
  }
};

// Mixes the audio of `frames` (in playback order) into one mono track. `getSamples(filename)` returns the
// decoded take at `sampleRate`. A frame shown longer than its recording is padded with silence.
export const renderDubAudio = ({ frames = [], fps = 12, sampleRate = 48000, getSamples = () => null }) => {
  const starts = getFrameStarts(frames);
  const toSample = (tick) => Math.round((tick / fps) * sampleRate);
  const output = new Float32Array(toSample(starts[starts.length - 1]));
  const fadeLength = Math.max(1, Math.round(SEAM_FADE_DURATION * sampleRate));

  let previous = null;
  frames.forEach((frame, i) => {
    const from = toSample(starts[i]);
    const frameSamples = toSample(starts[i + 1]) - from;
    const audio = frame.audio;
    const samples = audio ? getSamples(audio.filename) : null;
    if (!audio || !samples || frameSamples <= 0) {
      previous = null;
      return;
    }

    const offset = Math.round(audio.offset * sampleRate);
    const length = Math.min(frameSamples, Math.round(audio.duration * sampleRate), Math.max(0, samples.length - offset));
    if (length > 0) {
      output.set(samples.subarray(offset, offset + length), from);
    }
    if (!isContinuation(previous, audio)) {
      fadeSeam(output, from, fadeLength);
    }
    if (length < frameSamples) {
      fadeSeam(output, from + length, fadeLength);
    }
    previous = { ...audio, complete: length >= Math.round(audio.duration * sampleRate) };
  });
  return output;
};

// Groups exported frames (one entry per tick) back into frames with their audio and shown length
export const groupExportedFrames = (exportedFrames = [], pictures = []) => {
  const picturesById = new Map(pictures.map((p) => [`${p.id}`, p]));
  return exportedFrames.reduce((acc, frame) => {
    const last = acc[acc.length - 1];
    if (last && last.id === `${frame.id}`) {
      last.length++;
      return acc;
    }
    return [...acc, { id: `${frame.id}`, length: 1, audio: picturesById.get(`${frame.id}`)?.audio || null }];
  }, []);
};

// Mono 16-bit PCM WAV: universally decodable, and ffmpeg/WebCodecs take it as is
export const encodeWav = (samples, sampleRate) => {
  const dataSize = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const writeString = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return view.buffer;
};

// Reads the 16-bit PCM WAV written above (any channel count, mixed down to mono)
export const decodeWav = (arrayBuffer) => {
  const view = new DataView(arrayBuffer);
  let offset = 12;
  let channels = 1;
  let sampleRate = 48000;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(arrayBuffer, offset, 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
    } else if (id === 'data') {
      const length = Math.floor(Math.min(size, view.byteLength - offset - 8) / 2 / channels);
      const samples = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        let value = 0;
        for (let c = 0; c < channels; c++) {
          value += view.getInt16(offset + 8 + (i * channels + c) * 2, true);
        }
        samples[i] = value / channels / 0x8000;
      }
      return { samples, sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
};

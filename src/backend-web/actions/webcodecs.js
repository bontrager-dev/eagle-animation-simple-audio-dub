import { AudioBufferSource, BufferTarget, canEncodeAudio, canEncodeVideo, Mp4OutputFormat, Output, VideoSample, VideoSampleSource, WebMOutputFormat } from 'mediabunny';

const WEBCODECS_PROFILES = {
  h264: { codec: 'avc', audioCodec: 'aac', format: Mp4OutputFormat, extension: 'mp4', mimeType: 'video/mp4' },
  hevc: { codec: 'hevc', audioCodec: 'aac', format: Mp4OutputFormat, extension: 'mp4', mimeType: 'video/mp4' },
  vp8: { codec: 'vp8', audioCodec: 'opus', format: WebMOutputFormat, extension: 'webm', mimeType: 'video/webm' },
  vp9: { codec: 'vp9', audioCodec: 'opus', format: WebMOutputFormat, extension: 'webm', mimeType: 'video/webm' },
};

export const isFormatSupportedByWebCodecs = (format) => format in WEBCODECS_PROFILES;

export const isWebCodecsAvailable = async (format) => {
  if (!isFormatSupportedByWebCodecs(format)) return false;
  if (typeof VideoEncoder === 'undefined') return false;
  return canEncodeVideo(WEBCODECS_PROFILES[format].codec);
};

// Whether the format's audio codec can be encoded here (Chromium builds without AAC cannot)
export const isWebCodecsAudioAvailable = async (format, sampleRate = 48000) => {
  if (!isFormatSupportedByWebCodecs(format) || typeof AudioEncoder === 'undefined') return false;
  return canEncodeAudio(WEBCODECS_PROFILES[format].audioCodec, { numberOfChannels: 1, sampleRate });
};

export const exportWithWebCodecs = async (frames, format, fps, outputFps, onProgress, audio = null) => {
  const profile = WEBCODECS_PROFILES[format];

  const target = new BufferTarget();
  const output = new Output({
    format: new profile.format(),
    target,
  });

  const source = new VideoSampleSource({
    codec: profile.codec,
    bitrate: 8000000,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(source);

  // Dubbed audio track; the caller checked the codec with isWebCodecsAudioAvailable()
  let audioSource = null;
  if (audio?.samples?.length) {
    audioSource = new AudioBufferSource({ codec: profile.audioCodec, bitrate: 192000 });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  const frameDuration = 1 / outputFps;

  // The encoder keeps the timestamps it is given, it never resamples. A source frame
  // lasts 1/fps, so at a higher output rate it spans several samples and has to be
  // repeated — otherwise the animation would simply play faster.
  const sampleAt = (frameIndex) => Math.round((frameIndex * outputFps) / fps);

  for (let i = 0; i < frames.length; i++) {
    const blob = new Blob([frames[i].buffer], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);

    for (let index = sampleAt(i); index < sampleAt(i + 1); index++) {
      const sample = new VideoSample(bitmap, {
        timestamp: index * frameDuration,
        duration: frameDuration,
      });

      await source.add(sample);
      sample.close();
    }

    // Closed only once every sample drawn from it has been encoded
    bitmap.close();

    onProgress((i + 1) / frames.length);
  }

  if (audioSource) {
    const audioBuffer = new AudioBuffer({ length: audio.samples.length, numberOfChannels: 1, sampleRate: audio.sampleRate });
    audioBuffer.copyToChannel(audio.samples, 0);
    await audioSource.add(audioBuffer);
  }

  await output.finalize();

  return {
    buffer: target.buffer,
    filename: `video.${profile.extension}`,
    mimeType: profile.mimeType,
  };
};

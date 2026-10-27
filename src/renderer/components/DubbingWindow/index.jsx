import Button from '@components/Button';
import Select from '@components/Select';
import { DubAudio } from '@core/dubAudio';
import { computeTakeChanges, getDubFrames, getFrameIndexAtTick, getFrameStarts, MIN_TAKE_DURATION, renderDubAudio } from '@core/dubbing';
import { GamepadInput, getKeyboardAction, HoldRepeater, STEP_ACTIONS } from '@core/dubInput';
import { getPictureLink } from '@core/resize';
import { encodeWav } from '@core/wav';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import faChevronLeft from '@icons/faChevronLeft';
import faMicrophone from '@icons/faMicrophone';
import faPlay from '@icons/faPlay';
import faRotate from '@icons/faRotate';
import faStop from '@icons/faStop';
import resizeToFit from 'intrinsic-scale';
import { useEffect, useMemo, useRef, useState } from 'react';
import { withTranslation } from 'react-i18next';

import * as style from './style.module.css';

const PRELOAD_AHEAD = 30;
const PRELOAD_BEHIND = 10;

const formatTime = (seconds) => {
  const safeSeconds = Math.max(0, seconds);
  return `${Math.floor(safeSeconds / 60)}:${(safeSeconds % 60).toFixed(1).padStart(4, '0')}`;
};

const DubbingWindow = ({ t, projectId, trackId, pictures = [], fps = 12, initialFrameId = false, audioInputId = null, onAudioInputChange, onSaveAudio, onApplyDub, onUndo, onClose }) => {
  const frames = useMemo(() => getDubFrames(pictures), [pictures]);
  const starts = useMemo(() => getFrameStarts(frames), [frames]);
  const totalTicks = starts[starts.length - 1] || 0;

  const [index, setIndex] = useState(() => {
    const initialIndex = frames.findIndex((f) => f.id === initialFrameId);
    return initialIndex === -1 ? 0 : initialIndex;
  });
  const [mode, setMode] = useState('IDLE'); // IDLE, RECORDING, PLAYING, BUSY
  const [micStatus, setMicStatus] = useState('PENDING'); // PENDING, READY, UNAVAILABLE
  const [error, setError] = useState(null);
  const [inputDevices, setInputDevices] = useState([]);
  const [inputId, setInputId] = useState(audioInputId);

  const audioRef = useRef(null);
  const canvasRef = useRef(null);
  const meterRef = useRef(null);
  const cursorRef = useRef(null);
  const imagesRef = useRef(new Map());
  const takeRef = useRef(null);
  const playRef = useRef(null);
  const repeaterRef = useRef(new HoldRepeater());

  // Event handlers outlive renders, so they read the latest values from here
  const live = useRef({});
  live.current = { frames, starts, index, mode, fps, totalTicks, micStatus };

  // Device labels are only readable once a microphone has been opened
  const refreshInputDevices = async () => {
    const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []);
    setInputDevices((devices || []).filter((device) => device.kind === 'audioinput' && device.deviceId));
  };

  const openMicrophone = async (audio, deviceId) => {
    setMicStatus('PENDING');
    try {
      // A remembered device that is gone falls back to the default one
      await audio.openMicrophone(deviceId).catch((err) => (deviceId ? audio.openMicrophone(null) : Promise.reject(err)));
      if (audio.micReady) {
        setInputId(audio.deviceId);
        setMicStatus('READY');
      }
    } catch (err) {
      console.error('Microphone unavailable', err);
      setMicStatus('UNAVAILABLE');
    }
    refreshInputDevices();
  };

  // Audio engine: microphone, playback and decoded takes
  useEffect(() => {
    const audio = new DubAudio();
    audioRef.current = audio;
    audio.resume();
    openMicrophone(audio, audioInputId);
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshInputDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshInputDevices);
      audioRef.current = null;
      audio.close();
    };
  }, []);

  const handleInputChange = (event) => {
    // Select only styles itself as disabled, so switching mid-take is refused here
    if (live.current.mode !== 'IDLE') {
      return;
    }
    // Hand Space and Enter back to dubbing instead of the dropdown
    event.target.blur();
    const deviceId = event.target.value || null;
    setInputId(deviceId);
    if (audioRef.current) {
      openMicrophone(audioRef.current, deviceId);
    }
    onAudioInputChange?.(deviceId);
  };

  // Decode the takes used by this scene ahead of time, so playback starts right away
  useEffect(() => {
    const filenames = [...new Set(frames.filter((f) => f.audio).map((f) => f.audio.filename))];
    filenames.forEach((filename) => audioRef.current?.loadTake(projectId, trackId, filename));
  }, [frames, projectId, trackId]);

  // Keep the shown frame valid when frames change
  useEffect(() => {
    if (index > frames.length - 1) {
      setIndex(Math.max(0, frames.length - 1));
    }
  }, [frames.length, index]);

  const getImage = (frame) => {
    const link = getPictureLink(frame.link, { h: 720, m: 'contain', f: 'jpg' });
    if (!imagesRef.current.has(link)) {
      const img = new Image();
      img.src = link;
      imagesRef.current.set(link, img);
    }
    return imagesRef.current.get(link);
  };

  const drawFrame = (img) => {
    const canvas = canvasRef.current;
    if (!canvas || !img?.complete || !img.naturalWidth) {
      return;
    }
    const { width, height } = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const position = resizeToFit('contain', { width: img.naturalWidth, height: img.naturalHeight }, { width: canvas.width, height: canvas.height });
    ctx.drawImage(img, position.x, position.y, position.width, position.height);
  };

  // Draw the current frame and preload its neighbours
  useEffect(() => {
    const frame = frames[index];
    if (!frame) {
      return;
    }
    for (let i = Math.max(0, index - PRELOAD_BEHIND); i < Math.min(frames.length, index + PRELOAD_AHEAD); i++) {
      getImage(frames[i]);
    }
    const img = getImage(frame);
    if (img.complete) {
      drawFrame(img);
    } else {
      const handleLoad = () => live.current.frames[live.current.index]?.id === frame.id && drawFrame(img);
      img.addEventListener('load', handleLoad, { once: true });
      return () => img.removeEventListener('load', handleLoad);
    }
  }, [index, frames]);

  useEffect(() => {
    const handleResize = () => {
      const frame = live.current.frames[live.current.index];
      if (frame) {
        drawFrame(getImage(frame));
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const loadSamples = async (framesToPlay) => {
    const audio = audioRef.current;
    const filenames = [...new Set(framesToPlay.filter((f) => f.audio).map((f) => f.audio.filename))];
    const loaded = new Map(await Promise.all(filenames.map(async (filename) => [filename, await audio.loadTake(projectId, trackId, filename)])));
    return (filename) => loaded.get(filename) || null;
  };

  // Plays the sound under one frame while scrubbing
  const previewFrame = async (frame) => {
    const audio = audioRef.current;
    if (!audio || !frame?.audio) {
      audio?.stop();
      return;
    }
    const getSamples = await loadSamples([frame]);
    if (live.current.mode === 'IDLE' && live.current.frames[live.current.index]?.id === frame.id) {
      audio.play(renderDubAudio({ frames: [frame], fps: live.current.fps, sampleRate: audio.sampleRate, getSamples }));
    }
  };

  const goTo = (newIndex, preview = true) => {
    const { frames: currentFrames } = live.current;
    const clamped = Math.min(Math.max(0, newIndex), currentFrames.length - 1);
    if (clamped === live.current.index || clamped < 0) {
      return;
    }
    live.current.index = clamped;
    setIndex(clamped);
    if (preview) {
      previewFrame(currentFrames[clamped]);
    }
  };

  const setLiveMode = (newMode) => {
    live.current.mode = newMode;
    setMode(newMode);
  };

  const startRecording = (time) => {
    const audio = audioRef.current;
    // Until the mic is known to work or not, a take would wrongly be timing-only
    if (!audio || !live.current.frames.length || live.current.micStatus === 'PENDING') {
      return;
    }
    audio.stop();
    playRef.current = null;
    setError(null);
    audio.startTake(time);
    takeRef.current = { frames: live.current.frames, startIndex: live.current.index, steps: [] };
    setLiveMode('RECORDING');
  };

  const finishRecording = async (time) => {
    const audio = audioRef.current;
    const take = takeRef.current;
    takeRef.current = null;
    if (!audio || !take) {
      return;
    }
    const end = audio.takePosition(time);
    setLiveMode('BUSY');
    try {
      const samples = await audio.finishTake(time);
      if (!take.steps.length && end < MIN_TAKE_DURATION) {
        return;
      }
      let filename = null;
      if (samples?.length) {
        const saved = await onSaveAudio(encodeWav(samples, audio.sampleRate));
        filename = saved?.filename || null;
        if (filename) {
          audio.setTake(filename, samples);
        }
      }
      const changes = computeTakeChanges({ frames: take.frames, startIndex: take.startIndex, steps: take.steps, end, fps: live.current.fps, filename });
      if (changes.length) {
        onApplyDub(changes);
      }
    } catch (err) {
      console.error('Failed to save the recording', err);
      setError(t('The recording could not be saved'));
    } finally {
      setLiveMode('IDLE');
    }
  };

  const startPlayback = async () => {
    const audio = audioRef.current;
    const { frames: currentFrames, index: currentIndex, fps: currentFps } = live.current;
    if (!audio || !currentFrames.length) {
      return;
    }
    // From the last frame there is nothing left to play, so start over
    const startIndex = currentIndex >= currentFrames.length - 1 ? 0 : currentIndex;
    const framesToPlay = currentFrames.slice(startIndex);
    setLiveMode('BUSY');
    try {
      const getSamples = await loadSamples(framesToPlay);
      audio.play(renderDubAudio({ frames: framesToPlay, fps: currentFps, sampleRate: audio.sampleRate, getSamples }));
      playRef.current = { startIndex, starts: getFrameStarts(framesToPlay) };
      goTo(startIndex, false);
      setLiveMode('PLAYING');
    } catch (err) {
      console.error('Failed to play the recording', err);
      setLiveMode('IDLE');
    }
  };

  const stopPlayback = () => {
    audioRef.current?.stop();
    playRef.current = null;
    setLiveMode('IDLE');
  };

  const handleEvent = ({ action, pressed, time, hold = false }) => {
    const { mode: currentMode, index: currentIndex, frames: currentFrames } = live.current;

    // A held arrow or D-pad direction keeps stepping at the scene framerate
    if (hold && STEP_ACTIONS.includes(action)) {
      if (pressed) {
        repeaterRef.current.press(action, time, live.current.fps);
      } else {
        repeaterRef.current.release(action);
      }
    }

    if (currentMode === 'RECORDING') {
      if (action === 'RECORD' && !pressed) {
        finishRecording(time);
      } else if (action === 'STEP_FORWARD' && pressed && currentIndex < currentFrames.length - 1) {
        // Only moving forward makes sense while recording
        takeRef.current.steps.push(audioRef.current.takePosition(time));
        live.current.index = currentIndex + 1;
        setIndex(currentIndex + 1);
      }
      return;
    }
    if (!pressed || currentMode === 'BUSY') {
      return;
    }
    if (currentMode === 'PLAYING') {
      stopPlayback();
      if (action === 'PLAY') {
        return;
      }
    }

    if (action === 'RECORD') {
      startRecording(time);
    } else if (action === 'PLAY') {
      startPlayback();
    } else if (action === 'STEP_FORWARD') {
      goTo(currentIndex + 1);
    } else if (action === 'STEP_BACK') {
      goTo(currentIndex - 1);
    } else if (action === 'FIRST') {
      goTo(0, false);
    } else if (action === 'LAST') {
      goTo(currentFrames.length - 1, false);
    } else if (action === 'UNDO') {
      onUndo();
    } else if (action === 'CLOSE') {
      onClose();
    }
  };
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  // Keyboard, including a rotary encoder box that types arrow keys
  useEffect(() => {
    const handleKey = (pressed) => (event) => {
      const action = getKeyboardAction(event.key);
      if (!action || event.altKey || (event.ctrlKey && action !== 'UNDO') || event.metaKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Holding is handled by HoldRepeater at the scene framerate, not by the OS key repeat
      if (pressed && event.repeat) {
        return;
      }
      handleEventRef.current({ action, pressed, time: event.timeStamp || performance.now(), hold: true });
    };
    const handleKeyDown = handleKey(true);
    const handleKeyUp = handleKey(false);
    // Key releases are lost when the window loses focus
    const handleBlur = () => repeaterRef.current.release();
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // Animation loop: gamepad, playback position, level meter and timeline cursor
  useEffect(() => {
    const gamepad = new GamepadInput();
    let frameRequest = null;
    const loop = (now) => {
      [...gamepad.poll(now), ...repeaterRef.current.update(now)].sort((a, b) => a.time - b.time).forEach((event) => handleEventRef.current(event));

      const audio = audioRef.current;
      const { mode: currentMode, starts: currentStarts, totalTicks: currentTotal, index: currentIndex, fps: currentFps } = live.current;
      let cursorTick = currentStarts[currentIndex] || 0;

      if (currentMode === 'PLAYING' && audio && playRef.current) {
        const { startIndex, starts: playStarts } = playRef.current;
        const tick = Math.floor(audio.playPosition(performance.now()) * currentFps);
        if (tick >= playStarts[playStarts.length - 1]) {
          stopPlayback();
          goTo(live.current.frames.length - 1, false);
        } else {
          const playingIndex = startIndex + getFrameIndexAtTick(playStarts, tick);
          if (playingIndex !== currentIndex) {
            live.current.index = playingIndex;
            setIndex(playingIndex);
          }
          cursorTick = (currentStarts[startIndex] || 0) + tick;
        }
      }

      if (cursorRef.current) {
        cursorRef.current.style.left = `${currentTotal ? Math.min(100, (cursorTick / currentTotal) * 100) : 0}%`;
      }
      if (meterRef.current) {
        meterRef.current.style.transform = `scaleY(${Math.min(1, audio?.level || 0)})`;
      }
      frameRequest = requestAnimationFrame(loop);
    };
    frameRequest = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameRequest);
  }, []);

  // On-screen record button: held with mouse or touch
  const handleRecordPointer = (pressed) => (event) => {
    if (pressed) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (pressed || live.current.mode === 'RECORDING') {
      handleEvent({ action: 'RECORD', pressed, time: event.timeStamp || performance.now() });
    }
  };

  const currentFrame = frames[index] || null;
  const isRecording = mode === 'RECORDING';
  const isPlaying = mode === 'PLAYING';
  const currentSeconds = (starts[index] || 0) / fps;

  if (!frames.length) {
    return (
      <div className={style.container}>
        <div className={style.empty}>{t('Take some pictures before recording sound')}</div>
      </div>
    );
  }

  return (
    <div className={`${style.container} ${isRecording ? style.recording : ''}`}>
      <div className={style.header}>
        <FontAwesomeIcon icon={faMicrophone} className={style.headerIcon} />
        <span className={style.title}>{t('Audio dubbing')}</span>
        {isRecording && <span className={style.recordBadge}>{t('Recording')}</span>}
        {isPlaying && <span className={style.playBadge}>{t('Play')}</span>}
        {inputDevices.length > 0 && (
          <div className={style.inputSelect} title={t('Microphone')}>
            <Select
              value={inputId || ''}
              onChange={handleInputChange}
              disabled={mode !== 'IDLE'}
              options={inputDevices.map((device, i) => ({ value: device.deviceId, label: device.label || t('Microphone {{index}}', { index: i + 1 }) }))}
            />
          </div>
        )}
      </div>

      <div className={style.stage}>
        <canvas ref={canvasRef} className={style.canvas} />
        {micStatus === 'READY' && (
          <div className={style.meter} title={t('Microphone level')}>
            <div ref={meterRef} className={style.meterLevel} />
          </div>
        )}
      </div>

      <div className={style.timeline}>
        {frames.map((frame, i) => (
          <div
            key={frame.id}
            className={`${style.segment} ${frame.audio ? style.segmentAudio : ''} ${i === index ? style.segmentCurrent : ''}`}
            style={{ flexGrow: frame.length || 1 }}
            onClick={() => mode === 'IDLE' && goTo(i)}
          />
        ))}
        <div ref={cursorRef} className={style.cursor} />
      </div>

      <div className={style.infos}>
        <span>{t('Frame {{current}} / {{total}}', { current: index + 1, total: frames.length })}</span>
        <span className={style.infoMuted}>{t('Shown for {{duration}} s', { duration: ((currentFrame?.length || 1) / fps).toFixed(2) })}</span>
        <span>
          {formatTime(currentSeconds)} / {formatTime(totalTicks / fps)}
        </span>
      </div>

      {(micStatus === 'UNAVAILABLE' || error) && <div className={style.warning}>{error || t('Microphone unavailable, only the timing will be recorded')}</div>}

      <div className={style.navbar}>
        <Button icon={faChevronLeft} title={t('Previous frame')} onClick={() => handleEvent({ action: 'STEP_BACK', pressed: true, time: performance.now() })} disabled={isRecording || index === 0} />
        <div
          role="button"
          tabIndex={-1}
          className={`${style.recordButton} ${isRecording ? style.recordButtonActive : ''} ${mode === 'BUSY' || micStatus === 'PENDING' ? style.recordButtonDisabled : ''}`}
          onPointerDown={handleRecordPointer(true)}
          onPointerUp={handleRecordPointer(false)}
          onPointerCancel={handleRecordPointer(false)}
          title={t('Hold to record')}
        >
          <FontAwesomeIcon icon={faMicrophone} />
        </div>
        <Button
          icon={isPlaying ? faStop : faPlay}
          title={isPlaying ? t('Stop') : t('Play')}
          selected={isPlaying}
          selectedColor="warning"
          onClick={() => handleEvent({ action: 'PLAY', pressed: true, time: performance.now() })}
          disabled={isRecording}
        />
        <Button
          className={style.flipped}
          icon={faChevronLeft}
          title={t('Next frame')}
          onClick={() => handleEvent({ action: 'STEP_FORWARD', pressed: true, time: performance.now() })}
          disabled={isRecording || index >= frames.length - 1}
        />
        <Button icon={faRotate} title={t('Undo')} onClick={() => handleEvent({ action: 'UNDO', pressed: true, time: performance.now() })} disabled={mode !== 'IDLE'} />
      </div>

      <div className={style.hint}>{t('Arrows: move (hold to keep going) • Hold Enter: record • Space: play • Z: undo')}</div>
    </div>
  );
};

export default withTranslation()(DubbingWindow);

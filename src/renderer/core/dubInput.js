// Fully pressed triggers step this many frames per second, scaling down linearly to zero
export const TRIGGER_MAX_FPS = 24;
const TRIGGER_DEADZONE = 0.06;

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping)
const GAMEPAD_BUTTONS = {
  RECORD: [0, 5], // A, right bumper
  PLAY: [2, 9], // X, start
  UNDO: [3], // Y
  STEP_BACK: [14], // D-pad left
  STEP_FORWARD: [15], // D-pad right
};
const TRIGGER_BACK = 6;
const TRIGGER_FORWARD = 7;

export const KEYBOARD_KEYS = {
  RECORD: [' ', 'r', 'R'],
  PLAY: ['Enter', 'p', 'P'],
  UNDO: ['z', 'Z'],
  STEP_BACK: ['ArrowLeft', ','],
  STEP_FORWARD: ['ArrowRight', '.'],
  FIRST: ['Home'],
  LAST: ['End'],
  CLOSE: ['Escape'],
};

// Only stepping repeats while a key is held
export const REPEATING_ACTIONS = ['STEP_BACK', 'STEP_FORWARD'];

export const getKeyboardAction = (key) => Object.keys(KEYBOARD_KEYS).find((action) => KEYBOARD_KEYS[action].includes(key)) || null;

// Steps at a rate set by an analog trigger. Each step carries the moment it was due, so steps
// recorded with a trigger stay evenly spaced even though the screen only updates at 60 Hz.
export class TriggerScrubber {
  constructor(maxFps = TRIGGER_MAX_FPS, deadzone = TRIGGER_DEADZONE) {
    this.maxFps = maxFps;
    this.deadzone = deadzone;
    this.accumulator = 0;
  }

  rate(value) {
    if (value <= this.deadzone) {
      return 0;
    }
    return this.maxFps * Math.min(1, (value - this.deadzone) / (1 - this.deadzone));
  }

  update(value, now, dt) {
    const rate = this.rate(value);
    if (rate <= 0) {
      this.accumulator = 0;
      return [];
    }
    this.accumulator += rate * dt;
    const times = [];
    while (this.accumulator >= 1) {
      this.accumulator -= 1;
      times.push(now - (this.accumulator / rate) * 1000);
    }
    return times;
  }
}

// Turns gamepad state into { action, pressed, time } events. Call poll() once per animation frame.
export class GamepadInput {
  constructor() {
    this.pressed = new Map();
    this.forward = new TriggerScrubber();
    this.back = new TriggerScrubber();
    this.lastPoll = null;
  }

  poll(now) {
    const dt = this.lastPoll === null ? 0 : Math.min(0.1, (now - this.lastPoll) / 1000);
    this.lastPoll = now;
    const pads = [...(navigator.getGamepads?.() || [])].filter((pad) => pad && pad.mapping === 'standard');

    const events = [];
    for (const [action, indexes] of Object.entries(GAMEPAD_BUTTONS)) {
      const isPressed = pads.some((pad) => indexes.some((index) => pad.buttons[index]?.pressed));
      if (isPressed !== !!this.pressed.get(action)) {
        events.push({ action, pressed: isPressed, time: now });
        this.pressed.set(action, isPressed);
      }
    }

    const trigger = (index) => pads.reduce((max, pad) => Math.max(max, pad.buttons[index]?.value || 0), 0);
    events.push(...this.forward.update(trigger(TRIGGER_FORWARD), now, dt).map((time) => ({ action: 'STEP_FORWARD', pressed: true, time })));
    events.push(...this.back.update(trigger(TRIGGER_BACK), now, dt).map((time) => ({ action: 'STEP_BACK', pressed: true, time })));
    return events.sort((a, b) => a.time - b.time);
  }
}

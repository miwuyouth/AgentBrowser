import { thumbnail } from "./screenshot.ts";

export interface RecordedFrame {
  data: string; // jpeg base64
  width: number;
  height: number;
  label: string;
  /** Action point in frame pixels. */
  point?: [number, number];
}

const MAX_FRAMES = 150;

/** Frames for gif_creator. One recording at a time (the agent has one tab group). */
class Recorder {
  private recording = false;
  private frames: RecordedFrame[] = [];

  get isRecording() {
    return this.recording;
  }

  get frameCount() {
    return this.frames.length;
  }

  start() {
    this.recording = true;
  }

  stop() {
    this.recording = false;
  }

  clear() {
    this.recording = false;
    this.frames = [];
  }

  snapshot(): RecordedFrame[] {
    return [...this.frames];
  }

  async capture(tabId: number, action: { label: string; point?: [number, number] }) {
    const t = await thumbnail(tabId);
    const frame: RecordedFrame = { data: t.data, width: t.width, height: t.height, label: action.label };
    if (action.point) {
      frame.point = [(action.point[0] * t.width) / t.viewportWidth, (action.point[1] * t.height) / t.viewportHeight];
    }
    this.frames.push(frame);
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
  }
}

export const recorder = new Recorder();

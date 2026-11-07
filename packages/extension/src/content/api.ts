/** Functions the background calls inside the page (isolated world). */
export interface PageApi {
  tree(opts: TreeOptions): TreeResult;
  candidates(opts: { limit?: number }): FindCandidate[];
  pageText(maxChars: number): PageTextResult;
  elementPoint(ref: string): ElementPoint;
  scrollTo(ref: string): ElementPoint;
  setValue(ref: string, value: string | number | boolean): string;
  setFiles(ref: string, files: TransferFile[]): string;
  dropFiles(x: number, y: number, files: TransferFile[]): string;
  viewport(): Viewport;
}

export interface TreeOptions {
  filter: "interactive" | "all";
  depth: number;
  refId?: string;
  maxChars: number;
}

export interface TreeResult {
  text: string;
  elementCount: number;
  truncated: boolean;
}

export interface FindCandidate {
  ref: string;
  role: string;
  name: string;
  text?: string;
  context?: string;
  attrs?: string;
  href?: string;
  visible: boolean;
  inViewport: boolean;
  disabled?: boolean;
}

export interface PageTextResult {
  title: string;
  url: string;
  text: string;
  fullLength: number;
  source: string;
}

export interface ElementPoint {
  /** Centre in viewport CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  inViewport: boolean;
  /** Tag name of another element covering the centre point, if any. */
  coveredBy?: string;
  label: string;
}

export interface TransferFile {
  name: string;
  data: string; // base64
  mimeType?: string;
}

export interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

export interface PageError extends Error {
  code?: string;
}

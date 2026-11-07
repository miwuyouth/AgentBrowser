import { FILE_UPLOAD, FORM_INPUT, UPLOAD_IMAGE } from "@agent-browser/protocol";
import { ToolError } from "../errors.ts";
import { getImage } from "../images.ts";
import { callPage } from "../page.ts";
import { toViewport } from "../screenshot.ts";
import type { ToolSpec } from "./types.ts";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

export const formInputTool: ToolSpec = {
  name: FORM_INPUT.name,
  schema: FORM_INPUT.input_schema,
  needsTab: true,
  async run(input: { ref: string; value: string | number | boolean }, ctx) {
    const message = await callPage(ctx.tabId!, "setValue", input.ref, input.value);
    return { text: message, recordable: { label: "form_input" } };
  },
};

/** Extension-side file_upload: the App has already read the files into `files`. */
export const fileUploadTool: ToolSpec = {
  name: FILE_UPLOAD.name,
  schema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: { name: { type: "string" }, data: { type: "string" }, mimeType: { type: "string" } },
          required: ["name", "data"],
        },
      },
      ref: { type: "string" },
      tabId: { type: "integer" },
    },
    required: ["files", "ref", "tabId"],
  },
  needsTab: true,
  async run(input: { files: { name: string; data: string; mimeType?: string }[]; ref: string }, ctx) {
    const total = input.files.reduce((n, f) => n + base64Bytes(f.data), 0);
    if (total > MAX_UPLOAD_BYTES) throw new ToolError("input_invalid", `Files total ${Math.round(total / 1048576)} MB; the limit is 20 MB per call.`);
    const message = await callPage(ctx.tabId!, "setFiles", input.ref, input.files);
    return { text: message, recordable: { label: "file_upload" } };
  },
};

export const uploadImageTool: ToolSpec = {
  name: UPLOAD_IMAGE.name,
  schema: UPLOAD_IMAGE.input_schema,
  needsTab: true,
  async run(input: { imageId: string; ref?: string; coordinate?: [number, number]; filename?: string }, ctx) {
    if (Boolean(input.ref) === Boolean(input.coordinate)) throw new ToolError("input_invalid", "Give exactly one of ref or coordinate.");
    const img = getImage(input.imageId);
    if (!img) throw new ToolError("image_not_found", `No image with ID ${input.imageId}. Image IDs come from screenshot or zoom results in this session.`);
    const ext = img.mediaType === "image/png" ? "png" : img.mediaType === "image/gif" ? "gif" : "jpg";
    const file = { name: input.filename || `image.${ext}`, data: img.data, mimeType: img.mediaType };
    if (input.ref) {
      return { text: await callPage(ctx.tabId!, "setFiles", input.ref, [file]), recordable: { label: "upload_image" } };
    }
    const [x, y] = await toViewport(ctx.tabId!, input.coordinate!);
    return { text: await callPage(ctx.tabId!, "dropFiles", x, y, [file]), recordable: { label: "upload_image", point: [x, y] } };
  },
};

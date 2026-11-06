import { expect, test } from "@playwright/test";
import type { ClipboardImageRead } from "../../contracts/composer-attachments";
import type { ComposerImageAttachment } from "../../contracts/desktop-state";
import {
  extractFilesFromDataTransfer,
  extractImageFilesFromClipboardData,
  handleClipboardImageShortcut,
  hasFilesInDataTransfer,
} from "../../src/features/conversation/composer-attachments";

type Held = { readonly meta?: boolean; readonly ctrl?: boolean; readonly shift?: boolean };

function file(
  name: string,
  type: string,
  size = 16,
  extra: { readonly path?: string; readonly lastModified?: number } = {},
): File {
  return {
    name,
    type,
    size,
    lastModified: extra.lastModified ?? 1,
    path: extra.path,
  } as unknown as File;
}

function item(fileValue: File | null): DataTransferItem {
  return { kind: "file", getAsFile: () => fileValue } as unknown as DataTransferItem;
}

function dataTransfer(init: {
  readonly types?: readonly string[];
  readonly items?: readonly DataTransferItem[];
  readonly files?: readonly File[];
}): DataTransfer {
  return {
    types: init.types ?? [],
    items: init.items ?? [],
    files: init.files ?? [],
  } as unknown as DataTransfer;
}

function pasteEvent(key: string, held: Held) {
  const event = {
    key,
    metaKey: held.meta ?? false,
    ctrlKey: held.ctrl ?? false,
    shiftKey: held.shift ?? false,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  return event;
}

const pastedImage: ComposerImageAttachment = {
  id: "pasted",
  kind: "image",
  name: "pasted.png",
  mimeType: "image/png",
  data: "AA==",
};

test("treats a modifier+V paste as an image shortcut only when the bridge returns one", () => {
  const event = pasteEvent("v", { meta: true });
  const delivered: ComposerImageAttachment[] = [];
  const handled = handleClipboardImageShortcut(
    event as never,
    () => ({ ok: true, attachment: pastedImage }),
    (attachment) => delivered.push(attachment),
  );
  expect(handled).toBe(true);
  expect(event.prevented).toBe(true);
  expect(delivered).toEqual([pastedImage]);

  // A reader that returns nothing leaves the paste to the textarea.
  const fallback = pasteEvent("V", { ctrl: true });
  expect(
    handleClipboardImageShortcut(
      fallback as never,
      () => ({ ok: false }),
      () => {},
    ),
  ).toBe(false);
  expect(fallback.prevented).toBe(false);
});

test("ignores unmodified, shifted, and non-V pastes without reading the clipboard", () => {
  let reads = 0;
  const read = () => {
    reads += 1;
    return { ok: true, attachment: pastedImage } satisfies ClipboardImageRead;
  };
  const deliver = () => {};
  expect(handleClipboardImageShortcut(pasteEvent("v", {}) as never, read, deliver)).toBe(false);
  expect(
    handleClipboardImageShortcut(
      pasteEvent("v", { meta: true, shift: true }) as never,
      read,
      deliver,
    ),
  ).toBe(false);
  expect(
    handleClipboardImageShortcut(pasteEvent("x", { ctrl: true }) as never, read, deliver),
  ).toBe(false);
  expect(reads).toBe(0);
});

test("reports a refused clipboard image and still consumes the paste", () => {
  const event = pasteEvent("v", { ctrl: true });
  const errors: string[] = [];
  const handled = handleClipboardImageShortcut(
    event as never,
    () => ({ ok: false, message: "Image is too large" }),
    () => {},
    (message) => errors.push(message),
  );
  expect(handled).toBe(true);
  expect(event.prevented).toBe(true);
  expect(errors).toEqual(["Image is too large"]);
});

test("finds files in a data transfer through types, items, or the file list", () => {
  expect(hasFilesInDataTransfer(null)).toBe(false);
  expect(hasFilesInDataTransfer(undefined)).toBe(false);
  expect(hasFilesInDataTransfer(dataTransfer({}))).toBe(false);
  expect(hasFilesInDataTransfer(dataTransfer({ types: ["text/plain"] }))).toBe(false);
  expect(hasFilesInDataTransfer(dataTransfer({ types: ["Files"] }))).toBe(true);
  expect(hasFilesInDataTransfer(dataTransfer({ items: [item(file("a.png", "image/png"))] }))).toBe(
    true,
  );
  expect(hasFilesInDataTransfer(dataTransfer({ files: [file("a.txt", "text/plain")] }))).toBe(true);
});

test("extracts only supported images from the clipboard and dedupes repeated files", () => {
  const png = file("shot.png", "image/png");
  const jpegByExtension = file("photo.JPEG", "");
  const svg = file("diagram.svg", "image/svg+xml");
  const text = file("notes.txt", "text/plain");
  const transfer = dataTransfer({
    types: ["Files"],
    items: [item(png), item(null), item(text), item(jpegByExtension)],
    files: [png, jpegByExtension, svg],
  });
  expect(extractImageFilesFromClipboardData(transfer)).toEqual([png, jpegByExtension]);
  expect(extractImageFilesFromClipboardData(null)).toEqual([]);
});

test("extracts every attached file from a drop, keeping images and deduping", () => {
  const png = file("shot.png", "image/png");
  const text = file("notes.txt", "text/plain", 12, { path: "/tmp/notes.txt" });
  const transfer = dataTransfer({
    items: [item(png), item(text)],
    files: [png, text],
  });
  expect(extractFilesFromDataTransfer(transfer)).toEqual([png, text]);
  expect(extractFilesFromDataTransfer(undefined)).toEqual([]);
});

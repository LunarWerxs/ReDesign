import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InputDropzone from "@/components/app/control/InputDropzone.vue";
import ReferenceBlock from "@/components/app/control/ReferenceBlock.vue";
import { useControlStore } from "@/stores/control";

/**
 * Regression cover for the "one Ctrl+V, two uploads" bug (2026-07-21): InputDropzone listens for
 * `paste` on the DOCUMENT so a screenshot can be pasted anywhere on the page, and the reference
 * drop zone has its own `paste` handler. A paste aimed at the reference zone used to run both, so
 * the same image was added as a screenshot AND as a style reference.
 *
 * Two independent guards keep that fixed, and both are asserted here: the reference zone stops
 * propagation, and the document handler stands down for anything inside [data-reference-drop].
 */

function pasteEventWith(file: File): Event {
  // happy-dom has no ClipboardEvent constructor with a working DataTransfer, so hand-roll the
  // shape clipboardImageFiles() actually reads: items[] of kind "file", plus files[].
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      files: [file],
    },
  });
  return event;
}

function pngFile(name = "shot.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

describe("paste routing between the screenshot and reference drop zones", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("sends a paste inside the reference zone to references only, never to inputs", async () => {
    const store = useControlStore();
    const uploadFiles = vi.fn().mockResolvedValue(undefined);
    const uploadReferences = vi.fn().mockResolvedValue(undefined);
    store.uploadFiles = uploadFiles;
    store.uploadReferences = uploadReferences;
    store.referenceOn = true;

    const input = mount(InputDropzone, { attachTo: document.body });
    const reference = mount(ReferenceBlock, { attachTo: document.body });

    const zone = reference.element.parentElement?.querySelector("[data-reference-drop]");
    expect(zone, "reference panel should carry the data-reference-drop marker").toBeTruthy();

    zone?.dispatchEvent(pasteEventWith(pngFile()));
    await reference.vm.$nextTick();

    expect(uploadReferences).toHaveBeenCalledTimes(1);
    expect(uploadFiles).not.toHaveBeenCalled();

    input.unmount();
    reference.unmount();
  });

  it("still sends a paste aimed at nothing in particular to the screenshot inputs", async () => {
    const store = useControlStore();
    const uploadFiles = vi.fn().mockResolvedValue(undefined);
    const uploadReferences = vi.fn().mockResolvedValue(undefined);
    store.uploadFiles = uploadFiles;
    store.uploadReferences = uploadReferences;

    const input = mount(InputDropzone, { attachTo: document.body });

    document.body.dispatchEvent(pasteEventWith(pngFile()));
    await input.vm.$nextTick();

    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(uploadReferences).not.toHaveBeenCalled();

    input.unmount();
  });
});

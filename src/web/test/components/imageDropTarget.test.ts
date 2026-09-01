import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ImageDropTarget from "@/components/app/control/ImageDropTarget.vue";

/**
 * ImageDropTarget is the single drop target behind BOTH image zones — the screenshot dropzone
 * (InputDropzone) and the reference zone inside ReferenceBlock. Before it existed the two carried
 * a line-for-line copy of this wiring, and they had already drifted: the reference chip became a
 * <code> while its twin stayed a <span class="font-mono">.
 *
 * One component means one bug now reaches both zones, so the shared wiring is asserted here
 * rather than only through the two parents.
 */

function pngFile(name = "shot.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function mountTarget(props: Record<string, unknown> = {}) {
  return mount(ImageDropTarget, {
    attachTo: document.body,
    props: {
      uploading: false,
      label: "Paste or drop screenshots",
      hint: "Click to browse. New screenshots are copied into",
      folder: "input/",
      hintSuffix: "and selected.",
      ...props,
    },
  });
}

function dropEventWith(file: File): Event {
  // happy-dom's DragEvent has no working DataTransfer, so hand-roll the shape onDrop reads.
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
  return event;
}

describe("ImageDropTarget", () => {
  it("renders the folder as a <code>, which is what keeps it out of the i18n scan", () => {
    const w = mountTarget();
    const code = w.get("code");
    expect(code.text()).toBe("input/");
    // The whole point of the merge: the reference zone gets the same element, not a copy.
    expect(mountTarget({ folder: "reference/", dense: true }).get("code").text()).toBe("reference/");
    w.unmount();
  });

  it("emits picked files as 'browse' and clears the input so the same file re-fires", async () => {
    const w = mountTarget();
    const input = w.get<HTMLInputElement>("input[type=file]");
    Object.defineProperty(input.element, "files", { value: [pngFile()], configurable: true });

    await input.trigger("change");

    const emitted = w.emitted("files");
    expect(emitted).toHaveLength(1);
    expect((emitted?.[0][0] as File[])[0].name).toBe("shot.png");
    expect(emitted?.[0][1]).toBe("browse");
    // Reset is what makes a second pick of the SAME file fire `change` again.
    expect(input.element.value).toBe("");
    w.unmount();
  });

  it("emits dropped files as 'drop'", async () => {
    const w = mountTarget();
    w.element.dispatchEvent(dropEventWith(pngFile("dragged.png")));
    await w.vm.$nextTick();

    const emitted = w.emitted("files");
    expect(emitted).toHaveLength(1);
    expect((emitted?.[0][0] as File[])[0].name).toBe("dragged.png");
    expect(emitted?.[0][1]).toBe("drop");
    w.unmount();
  });

  it("opens the picker on Enter and Space, so the zone is reachable without a mouse", async () => {
    const w = mountTarget();
    let clicks = 0;
    w.get("input[type=file]").element.addEventListener("click", () => {
      clicks += 1;
    });

    await w.trigger("keydown", { key: "Enter" });
    await w.trigger("keydown", { key: " " });
    await w.trigger("keydown", { key: "a" });

    expect(clicks).toBe(2);
    w.unmount();
  });

  it("keeps the drag highlight lit through the upload and drops it when the upload settles", async () => {
    const w = mountTarget();
    await w.trigger("dragenter");
    expect(w.classes()).toContain("border-primary");

    // The parent owns `uploading` (paste uploads never touch this element), so the highlight
    // has to clear off the flag going down rather than off the drop itself.
    await w.setProps({ uploading: true });
    expect(w.classes()).toContain("border-primary");
    expect(w.classes()).toContain("pointer-events-none");

    await w.setProps({ uploading: false });
    expect(w.classes()).not.toContain("border-primary");
    w.unmount();
  });

  it("sizes itself from `dense`, which is the only thing the two zones disagree on", () => {
    expect(mountTarget().classes()).toContain("min-h-[86px]");
    expect(mountTarget({ dense: true }).classes()).toContain("min-h-[64px]");
  });
});

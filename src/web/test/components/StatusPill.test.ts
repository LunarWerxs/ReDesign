import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import StatusPill from "@/components/app/StatusPill.vue";

// Also the canary for the SFC pipeline itself: if the vue plugin or the `@` alias regresses,
// this file fails before any of the pure-lib specs notice.
describe("StatusPill.vue", () => {
  it("renders the text prop", () => {
    const wrapper = mount(StatusPill, { props: { text: "Idle" } });

    expect(wrapper.text()).toContain("Idle");
  });

  it("renders no spinner by default", () => {
    const wrapper = mount(StatusPill, { props: { text: "Idle" } });

    expect(wrapper.find(".animate-spin").exists()).toBe(false);
  });

  it("renders a spinner when live", () => {
    const wrapper = mount(StatusPill, { props: { live: true, text: "Running" } });

    expect(wrapper.find(".animate-spin").exists()).toBe(true);
    expect(wrapper.text()).toContain("Running");
  });

  it("lets slot content override the text prop", () => {
    const wrapper = mount(StatusPill, {
      props: { text: "fallback" },
      slots: { default: "from slot" },
    });

    expect(wrapper.text()).toContain("from slot");
    expect(wrapper.text()).not.toContain("fallback");
  });

  it("renders an empty pill when given neither text nor slot", () => {
    // Callers bind an optional status, so both props absent must stay harmless.
    const wrapper = mount(StatusPill);

    expect(wrapper.text()).toBe("");
    expect(wrapper.find("span").exists()).toBe(true);
  });
});

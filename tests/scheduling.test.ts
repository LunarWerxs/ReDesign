import { describe, expect, it } from "bun:test";
import type { Model, ResolvedPrompt } from "../src/config";
import type { InputItem } from "../src/inputResolver";
import { buildJobs } from "../src/runner/scheduling";

describe("job scheduling", () => {
  it("rejects duplicate job identities before workers can spend provider calls", () => {
    const input = {
      id: "screen",
      name: "screen.png",
      type: "image",
      images: ["screen.png"],
      imageCount: 1,
      preview: "screen.png",
    } as InputItem;
    const model = { id: "model", label: "Model", provider: "openai", keyEnv: "TEST_KEYS" } as Model;
    const prompt = { id: "preset", label: "Preset", user: "do it", source: "preset" } as ResolvedPrompt;
    expect(() => buildJobs({ inputItems: [input], models: [model], prompts: [prompt, prompt], variants: 1 })).toThrow("duplicate job id");
  });

  it("keeps saved and one-off Custom prompt job paths distinct and filesystem-safe", () => {
    const input = { id: "screen", name: "screen.png", type: "image", images: ["screen.png"], imageCount: 1, preview: "screen.png" } as InputItem;
    const model = { id: "model", label: "Model", provider: "openai", keyEnv: "TEST_KEYS" } as Model;
    const saved = { id: "custom", label: "Custom", user: "saved", source: "preset" } as ResolvedPrompt;
    const oneOff = { id: "custom-2", label: "Custom", user: "one-off", source: "custom" } as ResolvedPrompt;
    const jobs = buildJobs({ inputItems: [input], models: [model], prompts: [saved, oneOff], variants: 1 });
    expect(jobs.map((job) => job.id)).toEqual(["screen__model__custom__v1", "screen__model__custom-2__v1"]);
    expect(jobs.every((job) => !/[<>:"/\\|?*]/.test(job.id))).toBe(true);
  });
});

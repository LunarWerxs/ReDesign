# reference/

Drop **style / direction reference images** here (loose image files, or subfolders to
group them).

These are *not* screens to reimagine. When you flip on **Use reference image** in the
web UI (or pass `--reference` on the CLI) and pick one, it's sent to every model
*alongside* the input screenshot with an instruction to treat it purely as visual
direction, overall aesthetic, layout feel, color, typography, spacing, mood, and apply
that direction to its reimagining of the actual input.

- Vision models see the reference image directly.
- Text-only models (e.g. DeepSeek) get an auto-generated description of it instead.
- Add an optional note ("match this card style", "use this palette") to steer it further.

Supported: png, jpg/jpeg, webp, gif (same as `input/`).

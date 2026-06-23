# skills.md snapshot

Source URL: https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/skills.md

Key requirements captured for this build:

- Skills are file-backed capability packs.
- Skills are exposed as metadata in the system prompt, on-demand content through `skill://`, and optional `/skill:` commands.
- Provider-discovered layout is one level under `skills/`: `skills/<skill-name>/SKILL.md`.
- Nested skills are not discovered by provider loaders.
- Frontmatter supports `name`, `description`, `globs`, `alwaysApply`, `hide`, and related fields.
- Meaningful descriptions improve matching quality.

# hooks.md snapshot

Source URL: https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/hooks.md

Key requirements captured for this build:

- Current CLI runtime initializes the extension runner path.
- `--hook` is treated as an alias for `--extension`.
- JS/TS hook factories discovered through hook capability can load as extension modules.
- Hook modules default-export a factory and can register event handlers, messages, commands, renderers, and exec behavior.
- Important hook events include session lifecycle, context, before_agent_start, turn events, tool_call, and tool_result.
- `tool_call` may block execution; fail closed on handler errors.
- `tool_result` may patch output content/details.

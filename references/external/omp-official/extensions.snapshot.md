# extensions.md snapshot

Source URL: https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/extensions.md

Key requirements captured for this build:

- An extension is a TS/JS module exporting a default factory.
- Extensions can combine event handlers, LLM-callable tools, slash commands, keyboard shortcuts/flags, custom message rendering, and session/message injection APIs.
- Registration is valid during extension load; runtime actions are used from events/commands/tools.
- Core methods include `on`, `registerTool`, `registerCommand`, `registerMessageRenderer`, `sendMessage`, `sendUserMessage`, `appendEntry`, `exec`, `registerProvider`, and model helpers.
- Message delivery modes include `steer`, `followUp`, and `nextTurn`.
- Event surface includes `session_start`, `context`, `before_provider_request`, `tool_call`, `tool_result`, `session_before_compact`, `session.compacting`, `session_stop`, `turn_end`, `user_bash`, and `user_python`.
- Tool calls/results are intercepted by extensions.
- UI supports dialogs such as `select`, `confirm`, `input`, and `editor` in interactive mode.
- If one package needs policy, tools, command UX, and rendering together, use extensions.

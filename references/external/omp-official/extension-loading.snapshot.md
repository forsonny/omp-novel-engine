# extension-loading.md snapshot

Source URL: https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/extension-loading.md

Key requirements captured for this build:

- Project native extension modules are discovered from `/.omp/extensions`.
- User native extensions are discovered from `~/.omp/agent/extensions` or profile-specific equivalent.
- Explicit extension paths can also be configured in `.omp/config.yml`.
- Directory resolution checks package `omp.extensions`, then `index.ts`, then `index.js`, then one-level scan.
- Discovery is not recursive beyond one subdirectory level.
- TypeScript is preferred over JavaScript for `index.ts`/`index.js` pairs.
- Extension load failures are captured per path and do not stop other extension paths.

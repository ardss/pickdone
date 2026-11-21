# PickDone shared UI

Import `tokens.css` once in each Vue client, then import primitives from `index.js`. The package is presentation only: callers supply labels, data, actions and host adapters through props, slots and Vue events. `PdTaskCard`, `PdProjectCard` and `PdWorkEpisodeCard` are shared layout shells; each client owns its own navigation and form flows.

The semantic palette follows the desktop PickDone CSS and supports `data-theme="dark"` or the system dark preference. The official logo remains `pickdone/assets/img/favicon.svg`; clients should reference that canonical asset instead of recreating a brand mark.

Run `npm ci && npm test && npm run build` here to validate this package independently.
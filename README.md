# eve-pi

Run [PI](https://pi.dev) as an `eve` custom runner.

This package is for the runner-level integration:

```ts
import { defineAgent } from "eve";
import { piRunner } from "@balasivagn/eve-pi";

export default defineAgent({
  runner: piRunner({
    model: "gpt-5.5",
  }),
});
```

In this mode, PI is the coding agent. It owns its tool loop, session behavior,
model auth, and filesystem work. `eve` owns the filesystem-first agent project
and calls PI through the runner boundary.

## Install

```sh
pnpm add eve @balasivagn/eve-pi
```

You also need PI installed and authenticated:

```sh
npm install -g @earendil-works/pi-coding-agent
pi
```

## Usage

```ts
import { defineAgent } from "eve";
import { piRunner } from "@balasivagn/eve-pi";

export default defineAgent({
  runner: piRunner({
    provider: "openai-codex",
    model: "gpt-5.5",
  }),
});
```

By default, `eve-pi` runs:

```sh
pi --mode rpc
```

You can override the command for local development:

```ts
export default defineAgent({
  runner: piRunner({
    command: ["node", "/path/to/pi/packages/coding-agent/dist/cli.js", "--mode", "rpc"],
  }),
});
```

## Runner vs Model

There are two possible PI integrations:

```txt
PI as runner:
eve runner -> pi --mode rpc -> PI agent loop/tools/auth/session

PI as model:
eve model loop/tools/session -> PI-authenticated model provider
```

`@balasivagn/eve-pi` is the runner integration. That is the right path when PI
should act as the coding agent.

A model-level provider can be added separately later, similar in spirit to
`flue-pi-auth`, when the host framework should keep ownership of the agent loop.

# Claude subscription bridge Flightcheck

Run the deterministic API/CLI proof with one command:

```sh
npm run flightcheck
```

The runner uses the repository's fake Claude executable and random loopback
ports. It never calls Anthropic, reads the live router state, changes provider
selection, or touches either running ChatGPT instance. The sterile environment
is created under the operating system's temporary directory by the focused test
harness and removed after each flow.

Each run writes `qa/runs/<timestamp>/report.html`, `summary.json`, a terminal
recording (the API/CLI Flightcheck capture), process logs, and machine-readable
API/contract assertions. Runs are local, gitignored artifacts and are pruned
after seven days. Concurrent invocations serialize on a local lock so their
evidence cannot mix.

The four release flows are:

1. **State 0** — an installed but unauthenticated CLI keeps liveness green while
   readiness stays false.
2. **Aha moment** — a safe, isolated Claude child returns assistant text and a
   valid SSE completion.
3. **Core ritual** — Claude requests a Codex-owned tool, Codex supplies the
   result in the next turn, and the model finishes without executing a CLI tool.
4. **Gate moment** — bad auth/provider output, malformed tools, queue overflow,
   and request cancellation fail closed without leaking a child process.

Quota-consuming Opus/Fable compatibility probes are deliberately separate from
this deterministic Flightcheck and require explicit `--live --yes` flags. The
Flightcheck report is simulated adapter-contract evidence, never proof that the
real Claude provider answered.

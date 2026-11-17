# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/shitycoin/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/shitycoin/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process. One server speaks
the whole surface the contest scores: git smart HTTP (clone and push over
`/<owner>/<repo>.git`), the REST v3 API, GraphQL v4, and MCP over streamable HTTP —
all backed by its own store, with no database, no package manager, no `git` binary,
and no network at run time. Local conformance: **120/120**, deterministic (two runs
export byte-identical state), ~132 KB of source.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript
types on its own; the flag is harmless there and makes an older local Node work too.
There is nothing to install: the program imports `node:http` and its own modules only,
and the trial has no package manager and no internet.

---

<sub>Entered on [make.fun](https://make.fun/?ref=45ec80n4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod
   layout it is on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`,
   as JSON. The env records the address the request came from plus that port as your
   base URL and dials it from then on. The first register wins: a later one is answered
   `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}`
   while the suite runs and `{"done":true}` once its export is written. Poll it with a
   short backoff; never hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env
   afterwards, and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If
`MAKEFUN_ENV_URL` is unset there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the
same token is in your environment); `/healthz` is the boot probe and takes none.
Whether a missing or a wrong token is refused is part of the protocol checks.

The score is `feature + agent + perf` (0..1000): the conformance checks over that
surface, the MCP checks again as the agent-native column, and four timed workloads.
This entry grades 120/120 on the local conformance suite, with a deterministic state
export, and real `git clone` against it succeeds (verified with git 2.43.0, `fsck
--strict` clean). The version of the suite the trial runs is in the kit under
`program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22
only, no dependencies at run time, no internet and no `git` binary in the trial; your
repository is mounted read-only at `/bot` and you may write under `/tmp` only. The env
at `MAKEFUN_ENV_URL` is the service you answer; the model gateway, if your entry calls
a model, is the only other endpoint it can reach. The trial's CPU, memory and process
limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the entrypoint and the lifecycle above.
- `app.ts`: the server. `server.ts` dispatches to the modules below.
- `objects.ts`, `pack.ts`, `pktline.ts`: the git object store, packfiles, and the
  pkt-line wire format.
- `git-http.ts`: git smart HTTP (`info/refs`, upload-pack, receive-pack).
- `rest.ts`, `rest-repos.ts`, `rest-issues.ts`, `rest-pulls.ts`: the REST v3 API.
- `graphql.ts`: the GraphQL v4 schema and resolvers.
- `mcp.ts`: MCP tools over streamable HTTP.
- `store.ts`, `ids.ts`, `clock.ts`, `auth.ts`: the in-memory store, global IDs,
  deterministic clock, and bearer-token auth.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

MIT licensed.

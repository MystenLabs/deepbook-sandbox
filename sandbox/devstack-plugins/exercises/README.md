# Exercise 3 — write your own devstack plugin

Worksheet for the "Create your own plugin!" exercise in
[Intro to devstack & the Sui fork](https://app.notion.com/p/mystenlabs/Intro-to-devstack-the-Sui-fork-3c06d9dcb4e980108d93df5b6deb8f89).

Two files here:

| File                       | What it is                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `analytics-member.ts`      | An inert skeleton. Compiles, does nothing. Eight `TODO(n)` decisions. Edit it in place. |
| `analytics-member.test.ts` | A starter test that passes as shipped, plus two `it.todo`s that are your job.           |

> This worksheet is on purpose not a solution. Every section points you at a
> file in this repo that already made the same decision, and asks you what it
> decided and why. Reading a real member takes ten minutes and is the whole
> point of the exercise.

---

## 0. Before anything: what breaks without your member?

Write one paragraph. Not what it does — what is _wrong with the stack today_
that it fixes.

```
My member exists because ______________________________________________

Without it, ___________________________________________________________
```

If you cannot fill that in, you do not have a member yet — you have a script,
and a script belongs in `../scripts/`. Every real member in this package opens
with exactly this paragraph: read the top of `../clock-driver.ts` (a service)
and `../pools-seed.ts` (a task) for the standard.

The candidate the skeleton is shaped for: **an analytics member that keeps its
own record of what the trade simulator produces** — fills, prices, whatever you
find useful — in an embedded database (SQLite, DuckDB). Anything else is fine
too. The eight decisions below do not change.

---

## 1. The whole API surface

`definePlugin` is smaller than it looks. This is all of it:

```ts
definePlugin({
  id, // string — unique in the stack
  role, // 'service' | 'task'
  section, // 'service' | 'package' | 'account' | 'action' | 'app' | 'other'
  dependsOn, // optional: one ref, an array of refs, or a NAMED OBJECT of refs
  start, // (deps) => Effect<Value>   <- Value becomes what you publish
});
```

Two things about it are worth internalising before you write anything:

**`start` returns an `Effect`, not a `Promise`.** Its success value becomes this
plugin's published resource. That is the entire reason `dependsOn` composes —
what you `return` is literally what the next member reads off `deps`.

**The shape of `dependsOn` is the shape of `deps`.** Declare
`dependsOn: { postgres, indexer }` and `start(deps)` gets
`deps.postgres` / `deps.indexer`, fully typed, no casts. This is why the named
object form is the one to use. `../pools-seed.ts` reads
`deps.postgres.database` with full inference because of it.

---

## 2. `role` — service or task? (TODO(2))

|              | `task`                                    | `service`                               |
| ------------ | ----------------------------------------- | --------------------------------------- |
| Settles to   | `done`                                    | `ready`                                 |
| Runs         | once                                      | until the stack stops                   |
| Example here | `../pools-seed.ts`, `../registry-init.ts` | `../clock-driver.ts`, `../trade-sim.ts` |

The full lifecycle a row can be in: `pending`, `acquiring`, `ready`, `failed`,
`stopping`, `stopped`, `done`.

```
My role is __________ because __________________________________________
```

Ask yourself honestly: does your member ever stop having a job to do? An
analytics member that snapshots once at boot is a task. One that follows
trade-sim is a service. Both are defensible; picking one without noticing you
chose is not.

## 3. `section` — where your rows appear (TODO(3))

Purely a dashboard-grouping decision, but it is required precisely so the
renderer never has to guess from your plugin's name. Pick the bucket a reader
scanning `pnpm deploy-all` output would expect to find you in.

```
My section is __________ because _______________________________________
```

## 4. `dependsOn` — what must exist first? (TODO(1) and TODO(4))

Fill this in **before** you write `start`:

| I need... | from which member | am I _reading_ it, or just _ordering_ after it? |
| --------- | ----------------- | ----------------------------------------------- |
|           |                   |                                                 |
|           |                   |                                                 |

Two traps:

1. **Adding an option to `AnalyticsOptions` does not create an edge.** You must
   also list it in `dependsOn`. The starter test's third case is there to prove
   this to you.
2. **Every edge is boot time you are spending.** `../clock-driver.ts` depends on
   `registryInit` purely for ordering — and says so in a comment, because a
   dependency with no reads looks like a mistake six months later.

What the members you might depend on actually publish:

- `postgresMember` → `{ containerName, handle, network, alias, port, hostPort, user, password, database, dsn }`
- `tradeSimMember` → `{ enabled, pools, intervalMs, ohlcvMs, balanceManager, stats }`
- `suiRef` → the brokered RPC URL and, in fork mode, the `fork` admin surface

### The check that matters: does `dependsOn` actually gate your start?

Open `../pools-seed.ts`. It depends on **both** postgres and the indexer — and
then _still_ polls for the `pools` table before inserting a row.

```
Why? __________________________________________________________________
```

(The header comment answers it. Read it after you have written your guess.)
The general shape of the lesson: "ready" means whatever that member decided it
means, and it is rarely "finished doing everything I will ever do." If you
depend on a thing that migrates, seeds, or backfills, your edge orders you
after its _start_, not after its _work_.

## 5. Storage — where does the file live, and what happens on `wipe`? (TODO(5))

Three homes, three different answers:

| Home                                     | Survives `pnpm down`?      | Survives `docker rm`? |
| ---------------------------------------- | -------------------------- | --------------------- |
| The repo tree (`exercises/analytics.db`) | yes                        | yes                   |
| A named Docker volume                    | only if the wipe misses it | yes                   |
| A container's own writable layer         | no                         | no                    |

This repo made this exact decision for Postgres, and made it the _third_ way on
purpose. Read the header of `../postgres-member.ts`:

```
PGDATA was relocated off the image's VOLUME path so that ______________
```

The reason is in the root `CLAUDE.md` too: the fork chain resumes mainnet
checkpoint numbering from a pin, so stale indexer watermarks _must_ die with
the chain — "removing the container **is** the wipe" was the design goal, not a
side effect.

Now answer it for yourself:

```
My database lives at __________________________________________________

On `pnpm down` it ______________________________________________________

That is what I want because ____________________________________________
```

Is your record still meaningful against a _freshly reset chain_? If it is not,
persisting it across a wipe is a bug, not a feature.

`.gitignore` in this package already ignores `exercises/*.db`,
`exercises/*.sqlite*` and `exercises/*.duckdb` — a database file has no business
in a diff.

## 6. Idempotency — applying twice must not duplicate (TODO(6))

`pnpm deploy-all` is documented as idempotent while healthy, and people re-run
it freely. Your second boot must not double a single row.

```
The SQL construct I use is _____________________________________________

It works because my primary key is _____________________________________
```

`../pools-seed.ts` says of itself: _"The insert is idempotent, so this settles
to `done` on every boot."_ Find the SQL in `../pools-seed-sql.ts` and see what
that actually took — in particular, note that the guarantee lives in the
_schema_, not in a clever `INSERT`. An `ON CONFLICT` clause with nothing to
conflict _on_ is decoration.

Then write the test. This is `it.todo("does not duplicate rows when applied
twice")` in `analytics-member.test.ts`: run your setup twice against the same
store, assert the count did not change. You cannot eyeball this one.

## 7. The work, and the published value (TODO(7), TODO(8))

For a `service`, the loop shape this package uses everywhere:

```ts
yield * Effect.forkScoped(Effect.repeat(tick, Schedule.spaced(Duration.millis(intervalMs))));
```

`forkScoped` is doing real work there: the fiber dies with the plugin scope, so
your loop cannot outlive the stack. Read the end of `../clock-driver.ts`'s
`start()` — it also shows the other half, swallowing a transient failure
_inside_ `tick` so one bad RPC read does not take the member (and the stack)
down. Note the two different failure policies in that one function: the boot
catch-up is fatal, the steady-state tick is not.

Then decide what you publish:

```
I return ______________________________________________________________

because a later member reading `deps.analytics` would need __________
```

Return handles and counters, not internals.

---

## 8. Run it

From `sandbox/devstack-plugins/`:

```bash
pnpm typecheck    # your file is in scope; this is your fastest feedback loop
pnpm test         # includes exercises/**/*.test.ts
```

Both are green on the untouched skeleton — so if they go red, it is you, which
is the point.

Then wire it into the stack. In `../devstack.config.ts`, construct your member
next to the others and add it to the exported `members` array:

```ts
const analytics = analyticsMember({ sui: suiRef /* , ...your deps */ });

export const members = [, /* ... */ analytics];
```

> **Expect one red test the moment you do this.**
> `../__tests__/production-config.test.ts` asserts `expect(members).toHaveLength(22)`.
> That is deliberate — this repo pins the stack's composition so a member can
> never be added by accident. Bump the count and add your id to the
> `arrayContaining` list. Do not delete the assertion.

Finally, from `sandbox/`:

```bash
pnpm deploy-all
```

and look for your row in the output, in the section you chose, with the status
your `role` implies. If you are iterating, `pnpm down && pnpm deploy-all` — a
FAILED member has no re-drive path.

---

## 9. Self-check

- [ ] I can say in one sentence what breaks without my member.
- [ ] My `role` and `section` were chosen, not defaulted.
- [ ] Every entry in `dependsOn` is one I read from or must be ordered after — and I know which.
- [ ] I know what "ready" means for each member I depend on, and I probe for anything it does not cover.
- [ ] Applying twice does not duplicate rows, **and a test proves it**.
- [ ] I decided where my data lives and what a wipe does to it, and that answer is what I want.
- [ ] My loop dies with the stack; a transient failure does not.
- [ ] The value I publish is what another member would need.
- [ ] `pnpm typecheck` and `pnpm test` are green.
- [ ] My row shows up in `pnpm deploy-all`.

## Further reading

- [devstack docs](https://ts-sdks-incubation.vercel.app/devstack)
- `../README.md` — every shipped member in this package, and why it exists
- `../../SUI-FORK-ISSUES.md` — the fork defect catalog; the reason several members look the way they do
- Root `CLAUDE.md` — the stack table: every member, its ports, and its footnote

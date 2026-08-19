// EXERCISE SKELETON — write your own devstack plugin.
// ("Intro to devstack & the Sui fork", Exercise 3. Worksheet: ./README.md.)
//
// This file is deliberately INERT. It compiles, its shape is real, and it does
// nothing. Each TODO(n) is a decision you have to make and be able to defend;
// the matching section of ./README.md tells you where in this repo to find the
// EVIDENCE, not the answer.
//
// The candidate this skeleton is shaped for: an analytics member that keeps its
// own record of what the trade simulator produces (fills, prices — you decide
// what is worth recording) in an embedded database like SQLite or DuckDB.
// Any other member is equally fine. The eight decisions do not change.
//
// House style worth copying: every real member in this package opens with WHY
// it exists and what breaks without it — see clock-driver.ts (a service loop)
// and pools-seed.ts (a one-shot task). Write that paragraph for YOUR member
// before you write its code. If you cannot, you do not have a member yet; you
// have a script, and a script belongs in ../scripts/.
//
// This file is NOT wired into devstack.config.ts. Wiring it up is the last
// step of the exercise (README section 6) and the first time it will actually
// run.

import { Effect } from "effect";
import { definePlugin, type sui } from "@mysten-incubation/devstack";

import { memberError } from "../container-util.ts";

const MEMBER = "analytics";

/** Tagged failures keep the supervisor's lastErrorTag column meaningful.
 *  Call it as fail("<op>", "<what a reader should DO about it>", cause). */
const fail = memberError(MEMBER);

export type AnalyticsOptions = {
    /** Every fork member needs this. It carries the brokered RPC URL and the
     *  fork admin surface — resolve wiring from devstack state, never from a
     *  hardcoded port. */
    sui: ReturnType<typeof sui>;

    // TODO(1): which OTHER members must you be handed?
    //   Options are typed as `ReturnType<typeof xMember>` — see how
    //   pools-seed.ts declares `postgres` and `indexer`. Add only what you
    //   genuinely read from or must be ordered after. Every extra edge is a
    //   boot you are slowing down.
};

export function analyticsMember(opts: AnalyticsOptions) {
    // Config validation belongs HERE, not inside start(): it runs at config
    // load, so a bad env var fails before Docker is touched. clock-driver.ts
    // throws on an out-of-range CLOCK_INTERVAL_MS this way, and its unit test
    // exercises exactly that (stubs are enough — no dep is dereferenced yet).

    return definePlugin({
        id: MEMBER,

        // TODO(2): "service" or "task"?
        //   The union is exactly those two. A task runs once and settles to
        //   `done`; a service stays `ready` and holds something running.
        //   Which one is your member? Does it stop having a job to do?
        role: "service",

        // TODO(3): which dashboard section do your rows belong to?
        //   The union: "service" | "package" | "account" | "action" | "app" |
        //   "other". Pick the bucket a reader scanning the dashboard would
        //   expect to find you in.
        section: "other",

        // TODO(4): declare your dependencies.
        //   The object form is the one to use — the keys you write here are the
        //   keys you read off `deps` below, fully typed. Adding an option in
        //   TODO(1) does NOT create the edge; you must also list it here.
        dependsOn: { sui: opts.sui },

        start: (deps) =>
            Effect.gen(function* () {
                // Guard rails first, so a misconfigured stack fails with a
                // sentence instead of a stack trace 40 lines deeper.
                if (deps.sui.fork === null) {
                    return yield* Effect.fail(
                        fail(
                            "mode",
                            "the analytics member requires sui mode:'fork' — there is no fork " +
                                "admin surface on a plain localnet",
                        ),
                    );
                }

                // TODO(5): STORAGE. Where does your database file live?
                //   Three candidate homes, each with a different answer to
                //   "what happens on wipe": the repo tree, a Docker volume, or
                //   a container's own writable layer. Decide deliberately —
                //   see README section 5 for why this repo chose the third for
                //   Postgres. Whatever you pick, gitignore it.

                // TODO(6): SCHEMA. Create your tables — idempotently.
                //   devstack re-applies. `pnpm deploy-all` is documented as
                //   idempotent while healthy and people re-run it freely. Your
                //   second boot must not duplicate a single row. What SQL
                //   construct gives you that, and what does your primary key
                //   have to be for it to work?

                // TODO(7): THE WORK. Read from your dependency, write to your
                //   store, on a cadence.
                //   For a `service`, launch the loop with
                //     Effect.forkScoped(Effect.repeat(tick, Schedule.spaced(...)))
                //   so it dies with the plugin scope (add the `Duration` and
                //   `Schedule` imports). Two things to get right: a transient
                //   RPC hiccup must not take the member down, and the fiber
                //   must not outlive the stack. Read the end of
                //   clock-driver.ts's start() for both.

                // TODO(8): what does this member PUBLISH?
                //   Whatever you return becomes this plugin's resource value —
                //   it is what a LATER member reading `deps.analytics` would
                //   get, and what the dashboard shows. Return the handles and
                //   counters someone else would need, not your internals.
                return {
                    enabled: false as const,
                    reason: "analytics member not implemented yet — see exercises/README.md",
                };
            }),
    });
}

---
name: restart-killed-subagents
description: Use when a subagent or background task was killed, stopped, crashed, or died mid-task and needs to be brought back to finish its work. Restart it from its own transcript, never fresh.
---

# Restart killed subagents

A killed subagent still has its transcript. Use it.

## Do not respawn fresh

A fresh spawn starts with an empty context and throws away everything the agent
figured out — its plan, its progress, what it already ruled out. That is the exact
failure this skill exists to prevent. Never restart a killed agent from a blank slate.

## Resume from the transcript

Bring the agent back seeded from its own prior history so it keeps its context, then
let it continue the same task. Pick whichever resume path fits how it was spawned; the
transcript is the source of truth for where things stood — don't restate the task,
re-plan, or reset progress.

## Prepend one small re-entry note

Lead the restart with a short, non-distracting note — one or two sentences, nothing
that changes the objective:

> You were killed and have been restarted to continue after some time passed. Your task
> is unchanged — pick up where you left off.

If the agent was killed by a session limit, assume the limit has since reset — restart it
and let it continue.
